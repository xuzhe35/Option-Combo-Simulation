#!/usr/bin/env node
'use strict';

/**
 * Historical EOD validation for the calendar-Straddle projection.
 *
 * This deliberately loads the browser production pricing/clock/IVTS files.
 * It does not reimplement BSM, local-BBO IV inversion, the weighted clock, or
 * implied-lambda estimation in a second backtest model.
 *
 * The historical database contains one end-of-day row per contract and no
 * intraday timestamp.  Every row is therefore treated as the regular NYSE
 * 16:00 America/New_York close.  Results validate EOD behavior only; they are
 * not evidence about the last few minutes of an ES/FOP expiry.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { loadBrowserScripts } = require('../tests/helpers/load-browser-scripts');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_OPTIONS_DB = path.resolve(
    PROJECT_ROOT, '..', '..', 'Options DB', 'US_Stocks', 'market_data.cleaned.db'
);
const DEFAULT_RATES_DB = path.join(PROJECT_ROOT, 'sqlite_spy', 'rates.db');
const DAY_MS = 86400000;

const DEFAULT_CASES = Object.freeze([
    Object.freeze({
        label: 'weekday-only control',
        entry: '2026-02-17',
        front: '2026-02-18',
        back: '2026-02-19',
    }),
    Object.freeze({
        label: 'ordinary weekend',
        entry: '2026-02-23',
        front: '2026-02-27',
        back: '2026-03-02',
    }),
    Object.freeze({
        label: 'weekend plus MLK holiday',
        entry: '2026-01-12',
        front: '2026-01-16',
        back: '2026-01-20',
    }),
]);

function parseIsoDate(value, name = 'date') {
    const text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)
        || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return text;
}

function compactDate(value) {
    return parseIsoDate(value).replace(/-/g, '');
}

function calendarDays(start, end) {
    return Math.round(
        (Date.parse(`${parseIsoDate(end)}T00:00:00Z`)
            - Date.parse(`${parseIsoDate(start)}T00:00:00Z`)) / DAY_MS
    );
}

function parseCase(value, index) {
    const parts = String(value || '').split(':').map(item => item.trim());
    if (parts.length < 3 || parts.length > 5) {
        throw new Error(
            `Invalid --case ${value}; expected entry:front:back[:strike[:label]]`
        );
    }
    const strike = parts[3] === undefined || parts[3] === ''
        ? null
        : Number(parts[3]);
    if (strike !== null && (!Number.isFinite(strike) || strike <= 0)) {
        throw new Error(`Invalid case strike: ${parts[3]}`);
    }
    return {
        entry: parseIsoDate(parts[0], 'entry'),
        front: parseIsoDate(parts[1], 'front'),
        back: parseIsoDate(parts[2], 'back'),
        strike,
        label: parts[4] || `case ${index + 1}`,
    };
}

function parseArgs(argv) {
    const result = {
        db: DEFAULT_OPTIONS_DB,
        ratesDb: DEFAULT_RATES_DB,
        symbol: 'SPY',
        cases: [],
        maxSpreadPct: 0.35,
        maxLambdaDte: 45,
        json: '',
        help: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        const take = (name) => {
            index += 1;
            if (index >= argv.length) throw new Error(`Missing value for ${name}`);
            return argv[index];
        };
        if (token === '--db') result.db = path.resolve(take(token));
        else if (token === '--rates-db') result.ratesDb = path.resolve(take(token));
        else if (token === '--symbol') result.symbol = take(token).trim().toUpperCase();
        else if (token === '--case') result.cases.push(parseCase(take(token), result.cases.length));
        else if (token === '--max-spread-pct') result.maxSpreadPct = Number(take(token));
        else if (token === '--max-lambda-dte') result.maxLambdaDte = Number(take(token));
        else if (token === '--json') result.json = path.resolve(take(token));
        else if (token === '--help' || token === '-h') result.help = true;
        else throw new Error(`Unknown argument: ${token}`);
    }
    if (!result.symbol) throw new Error('Symbol is required');
    if (!(result.maxSpreadPct > 0)) throw new Error('--max-spread-pct must be positive');
    if (!(result.maxLambdaDte >= 7)) throw new Error('--max-lambda-dte must be at least 7');
    if (!result.cases.length) result.cases = DEFAULT_CASES.map(item => ({ ...item, strike: null }));
    return result;
}

function usage() {
    return [
        'Historical EOD calendar projection validation',
        '',
        'Usage:',
        '  node scripts/validate_calendar_projection.js [options]',
        '',
        'Options:',
        '  --symbol SPY',
        '  --case entry:front:back[:strike[:label]]   repeatable',
        '  --db /path/to/market_data.cleaned.db',
        '  --rates-db /path/to/rates.db',
        '  --max-spread-pct 0.35',
        '  --max-lambda-dte 45',
        '  --json /path/to/report.json',
        '',
        'All database lookups are exact-date and read-only. Missing data is a skip,',
        'never an on-or-before substitution.',
    ].join('\n');
}

function loadProductionRuntime() {
    return loadBrowserScripts([
        'js/official_exchange_calendars.generated.js',
        'js/market_holidays.js',
        'js/date_utils.js',
        'js/product_registry.js',
        'js/market_curves.js',
        'js/index_forward_rate.js',
        'js/pricing_context.js',
        'js/pricing_core.js',
        'js/iv_term_structure_core.js',
    ]);
}

class HistoricalDatabase {
    constructor(optionsPath, ratesPath) {
        this.options = new DatabaseSync(optionsPath, { readOnly: true });
        this.rates = new DatabaseSync(ratesPath, { readOnly: true });
        this._symbolId = this.options.prepare(
            'SELECT symbol_id FROM symbols WHERE symbol = ? LIMIT 1'
        );
        this._dateId = this.options.prepare(
            'SELECT date_id FROM dates WHERE date = ? LIMIT 1'
        );
        this._underlying = this.options.prepare(`
            SELECT close
            FROM underlying_prices
            WHERE symbol = ? AND price_date = ?
            LIMIT 1
        `);
        this._chain = this.options.prepare(`
            SELECT
                e.date AS expiration,
                o.strike,
                o.type,
                o.bid,
                o.ask,
                o.mark,
                o.last,
                o.open_interest AS openInterest,
                o.volume,
                o.implied_volatility AS vendorIv
            FROM options_data_clean o
            JOIN dates e ON e.date_id = o.expiration_ref
            WHERE o.symbol_ref = ?
              AND o.date_ref = ?
              AND julianday(e.date) - julianday(?) BETWEEN 0 AND ?
            ORDER BY e.date, o.strike, o.type
        `);
        this._chainDates = this.options.prepare(`
            SELECT DISTINCT d.date
            FROM options_data_clean o
            JOIN dates d ON d.date_id = o.date_ref
            WHERE o.symbol_ref = ?
              AND d.date BETWEEN ? AND ?
            ORDER BY d.date
        `);
        this._rate = this.rates.prepare(`
            SELECT d.date AS effectiveDate, r.rate, r.source
            FROM risk_free_daily_rates r
            JOIN dates d ON d.date_id = r.date_ref
            WHERE d.date <= ?
            ORDER BY d.date DESC
            LIMIT 1
        `);
    }

    close() {
        this.options.close();
        this.rates.close();
    }

    symbolId(symbol) {
        const row = this._symbolId.get(symbol);
        return row ? Number(row.symbol_id) : null;
    }

    closePrice(symbol, date) {
        const row = this._underlying.get(symbol, date);
        return row && Number.isFinite(Number(row.close)) ? Number(row.close) : null;
    }

    chain(symbol, date, maxDte) {
        const symbolId = this.symbolId(symbol);
        const dateRow = this._dateId.get(date);
        if (!symbolId || !dateRow) return [];
        return this._chain.all(symbolId, Number(dateRow.date_id), date, maxDte)
            .map(row => ({
                expiration: String(row.expiration),
                strike: Number(row.strike),
                type: String(row.type).toLowerCase(),
                bid: row.bid === null ? null : Number(row.bid),
                ask: row.ask === null ? null : Number(row.ask),
                mark: row.mark === null ? null : Number(row.mark),
                last: row.last === null ? null : Number(row.last),
                openInterest: row.openInterest === null ? null : Number(row.openInterest),
                volume: row.volume === null ? null : Number(row.volume),
                vendorIv: row.vendorIv === null ? null : Number(row.vendorIv),
            }));
    }

    chainDates(symbol, startDate, endDate) {
        const symbolId = this.symbolId(symbol);
        if (!symbolId) return [];
        return this._chainDates.all(symbolId, startDate, endDate)
            .map(row => String(row.date));
    }

    rate(date) {
        const row = this._rate.get(date);
        if (!row || !Number.isFinite(Number(row.rate))) return null;
        return {
            effectiveDate: String(row.effectiveDate),
            rate: Number(row.rate),
            source: String(row.source || ''),
            ageDays: calendarDays(String(row.effectiveDate), date),
        };
    }
}

function bbo(row, maxSpreadPct, positiveBid = false) {
    if (!row) return null;
    const bid = Number(row.bid);
    const ask = Number(row.ask);
    if (!Number.isFinite(bid) || !Number.isFinite(ask)
        || bid < 0 || ask <= 0 || ask < bid || (positiveBid && bid <= 0)) {
        return null;
    }
    const midpoint = (bid + ask) / 2;
    if (!(midpoint > 0)) return null;
    const spreadPct = (ask - bid) / midpoint;
    if (Number.isFinite(maxSpreadPct) && spreadPct > maxSpreadPct) return null;
    return { bid, ask, midpoint, spreadPct };
}

function pairKey(expiration, strike) {
    return `${expiration}|${Number(strike).toFixed(4)}`;
}

function buildPairMap(rows, maxSpreadPct, positiveBid = false) {
    const partial = new Map();
    for (const row of rows) {
        if (!['call', 'put'].includes(row.type)) continue;
        const quote = bbo(row, maxSpreadPct, positiveBid);
        if (!quote) continue;
        const key = pairKey(row.expiration, row.strike);
        if (!partial.has(key)) {
            partial.set(key, {
                expiration: row.expiration,
                strike: row.strike,
                call: null,
                put: null,
            });
        }
        partial.get(key)[row.type] = { ...quote, raw: row };
    }
    return new Map([...partial].filter(([, pair]) => pair.call && pair.put));
}

function pairsForExpiry(pairMap, expiry) {
    return [...pairMap.values()].filter(pair => pair.expiration === expiry);
}

function chooseLambdaAtmPairs(pairMap, spot) {
    const byExpiry = new Map();
    for (const pair of pairMap.values()) {
        const score = [
            Math.abs(pair.call.midpoint - pair.put.midpoint),
            Math.abs(pair.strike - spot),
            pair.strike,
        ];
        const current = byExpiry.get(pair.expiration);
        if (!current || score.some((value, index) => (
            value < current.score[index]
                && score.slice(0, index).every((prefix, prefixIndex) => prefix === current.score[prefixIndex])
        ))) {
            byExpiry.set(pair.expiration, { pair, score });
        }
    }
    return [...byExpiry.values()].map(item => item.pair)
        .sort((left, right) => left.expiration.localeCompare(right.expiration));
}

function closeAsOf(runtime, date) {
    const ms = runtime.OptionComboDateUtils.zonedDateTimeToUtcMs(
        date, 16, 0, 'America/New_York'
    );
    if (!Number.isFinite(ms)) throw new Error(`Cannot resolve NY close for ${date}`);
    return new Date(ms).toISOString();
}

function computeStructuredLambda(runtime, params) {
    const {
        date, spot, rate, rows, maxSpreadPct, maxDte, frontIntervalVerified = false,
    } = params;
    const quoteAsOf = closeAsOf(runtime, date);
    const snapshotId = `historical-eod:${params.symbol}:${date}`;
    const pairMap = buildPairMap(rows, maxSpreadPct, true);
    const atmPairs = chooseLambdaAtmPairs(pairMap, spot)
        .filter(pair => {
            const dte = calendarDays(date, pair.expiration);
            return dte >= 1 && dte <= maxDte;
        });
    const detailRows = atmPairs.map(pair => {
        const expiryAsOf = closeAsOf(runtime, pair.expiration);
        return {
            expiry: compactDate(pair.expiration),
            dte: calendarDays(date, pair.expiration),
            timeYears: (Date.parse(expiryAsOf) - Date.parse(quoteAsOf)) / DAY_MS / 365,
            atmStrike: pair.strike,
            callMark: pair.call.midpoint,
            putMark: pair.put.midpoint,
            callBid: pair.call.bid,
            callAsk: pair.call.ask,
            putBid: pair.put.bid,
            putAsk: pair.put.ask,
            callMarkSource: 'bid_ask_mid',
            putMarkSource: 'bid_ask_mid',
            callQuoteAsOf: quoteAsOf,
            putQuoteAsOf: quoteAsOf,
            callExpiryAsOf: expiryAsOf,
            putExpiryAsOf: expiryAsOf,
            callSnapshotId: snapshotId,
            putSnapshotId: snapshotId,
        };
    });
    const result = runtime.OptionComboIvTermStructureCore.computeImpliedWeekendLambdas(
        detailRows,
        date,
        {
            calendarKey: 'NYSE',
            varianceSource: 'straddle',
            pricingModel: 'bsm-spot',
            underlyingQuoteIsForward: false,
            underlyingPrice: spot,
            interestRate: rate,
            maxBidAskSpreadPct: maxSpreadPct,
            maxForwardDeviationPct: null,
            maxQuoteSkewMs: 1000,
            minDte: 1,
            maxIntervalCalendarDays: 7,
            baselineWindowDays: 7,
            minBaselines: 2,
            frontIntervalVerified,
            requireCoherentSnapshot: true,
            requireExactExpiryTimestamps: true,
            timeZone: 'America/New_York',
            snapshotMetadata: {
                snapshotId,
                underlyingSnapshotId: snapshotId,
                coherent: true,
                quoteComplete: true,
                quoteAsOf,
                underlyingQuoteAsOf: quoteAsOf,
            },
        }
    );
    return { result, detailRows, quoteAsOf };
}

function chooseCalendarStrike(entryPairs, exitPairs, spec, spot, maxSpreadPct) {
    const requested = Number(spec.strike);
    const candidates = pairsForExpiry(entryPairs, spec.front)
        .map(front => {
            const back = entryPairs.get(pairKey(spec.back, front.strike));
            const exit = exitPairs.get(pairKey(spec.back, front.strike));
            if (!back || !exit) return null;
            const entryDebit = back.call.midpoint + back.put.midpoint
                - front.call.midpoint - front.put.midpoint;
            const targetIntrinsic = Math.abs(spec.targetSpot - front.strike);
            const exitFarMid = exit.call.midpoint + exit.put.midpoint;
            if (!(entryDebit > 0) || exitFarMid + 1e-8 < targetIntrinsic) return null;
            if (requested && Math.abs(front.strike - requested) > 1e-6) return null;
            return {
                strike: front.strike,
                front,
                back,
                exit,
                entryDebit,
                distance: Math.abs(front.strike - spot),
                maxSpreadPct: Math.max(
                    front.call.spreadPct, front.put.spreadPct,
                    back.call.spreadPct, back.put.spreadPct,
                    exit.call.spreadPct, exit.put.spreadPct
                ),
            };
        })
        .filter(Boolean)
        .filter(item => item.maxSpreadPct <= maxSpreadPct)
        .sort((left, right) => left.distance - right.distance || left.strike - right.strike);
    return candidates[0] || null;
}

function makeLeg(id, type, pos, expiry, expiryAsOf, strike, midpoint, cost) {
    return {
        id,
        type,
        pos,
        strike,
        expDate: expiry,
        expiryAsOf,
        iv: 0.5,
        ivSource: 'live',
        cost,
        currentPrice: midpoint,
        currentPriceSource: 'live',
        closePrice: null,
    };
}

function requiredClock(runtime, startAsOf, endAsOf, lambdaSpec) {
    return runtime.OptionComboDateUtils.resolveWeightedTime(
        startAsOf,
        endAsOf,
        lambdaSpec,
        'NYSE',
        null,
        'America/New_York',
        null
    );
}

function lambdaSpecForInterval(runtime, lambdaResult, quoteAsOf, farAsOf) {
    const probe = requiredClock(runtime, quoteAsOf, farAsOf, {
        default: 0,
        strictByDate: false,
    });
    if (!probe || probe.available !== true) {
        return { ready: false, status: probe && probe.status || 'clock_unavailable' };
    }
    const requiredDates = [...new Set(probe.nonTradingDates || [])].sort();
    if (!requiredDates.length) {
        return {
            ready: true,
            required: false,
            status: 'not_required',
            requiredDates,
            missingDates: [],
            spec: { default: 0, strictByDate: true, byDate: {} },
        };
    }
    const byDate = lambdaResult && lambdaResult.byDate && typeof lambdaResult.byDate === 'object'
        ? lambdaResult.byDate
        : {};
    const missingDates = requiredDates.filter(date => !Number.isFinite(Number(byDate[date])));
    return {
        ready: missingDates.length === 0,
        required: true,
        status: missingDates.length ? 'missing_dates' : 'complete',
        requiredDates,
        missingDates,
        spec: {
            default: Number.isFinite(Number(lambdaResult && lambdaResult.medianLambda))
                ? Number(lambdaResult.medianLambda)
                : 0,
            strictByDate: true,
            byDate: Object.fromEntries(requiredDates
                .filter(date => Number.isFinite(Number(byDate[date])))
                .map(date => [date, Number(byDate[date])])),
        },
    };
}

function projectAtTarget(runtime, params) {
    const {
        symbol, quoteDate, targetDate, farExpiry, strike, quoteSpot, targetSpot,
        rate, farPair, frontPair, entryDebit, lambdaCoverage, targetOffsetMs = 0,
    } = params;
    const quoteAsOf = closeAsOf(runtime, quoteDate);
    const targetAsOf = new Date(
        Date.parse(closeAsOf(runtime, targetDate)) + Number(targetOffsetMs || 0)
    ).toISOString();
    const frontAsOf = closeAsOf(runtime, targetDate);
    const farAsOf = closeAsOf(runtime, farExpiry);
    runtime.configureSimTimeBasis({ weekendWeight: lambdaCoverage.spec });
    const profile = runtime.OptionComboProductRegistry.resolveUnderlyingProfile(symbol);
    const legs = [
        makeLeg('near-call', 'call', -1, targetDate, frontAsOf, strike,
            frontPair ? frontPair.call.midpoint : 0, frontPair ? frontPair.call.midpoint : 0),
        makeLeg('near-put', 'put', -1, targetDate, frontAsOf, strike,
            frontPair ? frontPair.put.midpoint : 0, frontPair ? frontPair.put.midpoint : 0),
        makeLeg('far-call', 'call', 1, farExpiry, farAsOf, strike,
            farPair.call.midpoint, farPair.call.midpoint),
        makeLeg('far-put', 'put', 1, farExpiry, farAsOf, strike,
            farPair.put.midpoint, farPair.put.midpoint),
    ];
    const timing = (observablePrice = null) => ({
        quoteAsOf,
        targetAsOf,
        targetSource: 'near-leg-contract-cutoff',
        observablePrice,
        observablePriceSource: observablePrice === null ? '' : 'live_midpoint',
        observablePriceAsOf: observablePrice === null ? null : quoteAsOf,
        observablePriceFresh: observablePrice !== null,
        quotePricingInputsAvailable: observablePrice !== null,
        quotePricingInputStatus: observablePrice === null ? 'not_required' : 'ok',
        quoteUnderlyingPrice: quoteSpot,
        quoteUnderlyingAsOf: quoteAsOf,
        quoteInterestRate: rate,
    });
    const processed = legs.map((leg, index) => runtime.processLegData(
        leg,
        targetDate,
        0,
        quoteDate,
        quoteSpot,
        rate,
        'active',
        profile,
        'live',
        timing(index < 2 ? null : farPair[leg.type].midpoint)
    ));
    const state = {
        marketDataMode: 'live',
        projectionConvergenceMode: 'strict-bbo',
        simImpliedLambdaCoverage: {
            ...lambdaCoverage,
            affectedLegIds: ['far-call', 'far-put'],
        },
        liveProjectionFeedConnected: true,
        liveProjectionFeedStale: false,
    };
    const convergence = runtime.assessProjectionConvergence(state, legs, processed);
    if (!convergence.ready) {
        return {
            ready: false,
            status: convergence.status,
            detail: runtime.formatProjectionConvergenceFailure(convergence, 'Historical validation'),
            convergence,
            processed,
        };
    }
    if (processed.some(leg => leg.timingAvailable !== true)) {
        const failed = processed.find(leg => leg.timingAvailable !== true);
        return {
            ready: false,
            status: failed && failed.timingStatus || 'timing_unavailable',
            processed,
        };
    }
    const legPrices = processed.map((leg, index) => runtime.computeSimulatedPrice(
        leg,
        legs[index],
        targetSpot,
        rate,
        'active',
        targetDate,
        quoteDate,
        0
    ));
    if (legPrices.some(price => !Number.isFinite(price))) {
        return { ready: false, status: 'model_price_unavailable', processed, legPrices };
    }
    const projectedFar = legPrices[2] + legPrices[3];
    const intrinsic = Math.abs(targetSpot - strike);
    const projectedPnl = (projectedFar - intrinsic - entryDebit) * profile.optionMultiplier;
    return {
        ready: true,
        status: lambdaCoverage.status,
        quoteAsOf,
        targetAsOf,
        farAsOf,
        projectedFar,
        intrinsic,
        projectedPnl,
        legPrices,
        localIv: {
            call: processed[2].localImpliedIv,
            put: processed[3].localImpliedIv,
        },
        clocks: {
            callT: processed[2].T,
            callRateT: processed[2].rateT,
            effectiveDays: processed[2].T
                * runtime.weightedDaysPerYear(lambdaCoverage.spec),
            calendarDays: processed[2].rateT * 365,
        },
        convergence,
    };
}

function exactPairForStrike(pairMap, expiry, strike) {
    return pairMap.get(pairKey(expiry, strike)) || null;
}

function counterfactualCoverage(baseCoverage, weight) {
    const byDate = Object.fromEntries(
        (baseCoverage.requiredDates || []).map(date => [date, weight])
    );
    return {
        ...baseCoverage,
        ready: true,
        status: baseCoverage.required ? `research_lambda_${weight}` : 'not_required',
        missingDates: [],
        spec: {
            default: weight,
            strictByDate: true,
            byDate,
        },
    };
}

function summarizeCase(runtime, database, args, spec) {
    const entrySpot = database.closePrice(args.symbol, spec.entry);
    const targetSpot = database.closePrice(args.symbol, spec.front);
    const entryRate = database.rate(spec.entry);
    if (!(entrySpot > 0) || !(targetSpot > 0) || !entryRate) {
        return {
            label: spec.label,
            status: 'skipped',
            reason: 'missing_underlying_or_rate',
            spec,
        };
    }

    const entryRows = database.chain(args.symbol, spec.entry, args.maxLambdaDte);
    const exitRows = database.chain(args.symbol, spec.front, args.maxLambdaDte);
    if (!entryRows.length || !exitRows.length) {
        return { label: spec.label, status: 'skipped', reason: 'missing_exact_chain', spec };
    }
    const entryPairs = buildPairMap(entryRows, args.maxSpreadPct, false);
    const exitPairs = buildPairMap(exitRows, args.maxSpreadPct, false);
    const selected = chooseCalendarStrike(
        entryPairs,
        exitPairs,
        { ...spec, targetSpot },
        entrySpot,
        args.maxSpreadPct
    );
    if (!selected) {
        return { label: spec.label, status: 'skipped', reason: 'no_shared_liquid_strike', spec };
    }

    const entryLambda = computeStructuredLambda(runtime, {
        symbol: args.symbol,
        date: spec.entry,
        spot: entrySpot,
        rate: entryRate.rate,
        rows: entryRows,
        maxSpreadPct: args.maxSpreadPct,
        maxDte: args.maxLambdaDte,
    });
    const farAsOf = closeAsOf(runtime, spec.back);
    const entryCoverage = lambdaSpecForInterval(
        runtime, entryLambda.result, entryLambda.quoteAsOf, farAsOf
    );
    if (!entryCoverage.ready) {
        return {
            label: spec.label,
            status: 'skipped',
            reason: 'entry_structured_lambda_unavailable',
            spec,
            lambdaQuality: entryLambda.result.quality,
            coverage: entryCoverage,
        };
    }

    const entryProjection = projectAtTarget(runtime, {
        symbol: args.symbol,
        quoteDate: spec.entry,
        targetDate: spec.front,
        farExpiry: spec.back,
        strike: selected.strike,
        quoteSpot: entrySpot,
        targetSpot,
        rate: entryRate.rate,
        farPair: selected.back,
        frontPair: selected.front,
        entryDebit: selected.entryDebit,
        lambdaCoverage: entryCoverage,
    });
    if (!entryProjection.ready) {
        return {
            label: spec.label,
            status: 'skipped',
            reason: `entry_projection_${entryProjection.status}`,
            spec,
            coverage: entryCoverage,
        };
    }

    const targetRate = database.rate(spec.front) || entryRate;
    const targetLambda = computeStructuredLambda(runtime, {
        symbol: args.symbol,
        date: spec.front,
        spot: targetSpot,
        rate: targetRate.rate,
        rows: exitRows,
        maxSpreadPct: args.maxSpreadPct,
        maxDte: args.maxLambdaDte,
        frontIntervalVerified: true,
    });
    const targetAsOf = closeAsOf(runtime, spec.front);
    const targetCoverage = lambdaSpecForInterval(
        runtime, targetLambda.result, targetAsOf, farAsOf
    );
    const targetFarPair = exactPairForStrike(exitPairs, spec.back, selected.strike);
    let boundaryProjection = null;
    if (targetCoverage.ready && targetFarPair) {
        boundaryProjection = projectAtTarget(runtime, {
            symbol: args.symbol,
            quoteDate: spec.front,
            targetDate: spec.front,
            farExpiry: spec.back,
            strike: selected.strike,
            quoteSpot: targetSpot,
            targetSpot,
            rate: targetRate.rate,
            farPair: targetFarPair,
            frontPair: null,
            entryDebit: selected.entryDebit,
            lambdaCoverage: targetCoverage,
            // Move one millisecond past the observable BBO boundary. This
            // forces the production model/clock path instead of accepting the
            // current midpoint as an identity shortcut, while remaining the
            // numerical limit relevant to the user's convergence criterion.
            targetOffsetMs: 1,
        });
    }

    const exitFarMid = selected.exit.call.midpoint + selected.exit.put.midpoint;
    const exitFarBid = selected.exit.call.bid + selected.exit.put.bid;
    const exitFarAsk = selected.exit.call.ask + selected.exit.put.ask;
    const intrinsic = Math.abs(targetSpot - selected.strike);
    const paperPnl = (exitFarMid - intrinsic - selected.entryDebit) * 100;
    const entryError = entryProjection.projectedPnl - paperPnl;
    const boundaryError = boundaryProjection && boundaryProjection.ready
        ? boundaryProjection.projectedPnl - paperPnl
        : null;
    const replayPath = [{
        date: spec.entry,
        status: 'ok',
        horizonCalendarDays: calendarDays(spec.entry, spec.front),
        forecastPnl: entryProjection.projectedPnl,
        error: entryError,
        absError: Math.abs(entryError),
        forecastFar: entryProjection.projectedFar,
        localIv: entryProjection.localIv,
        lambdaStatus: entryCoverage.status,
        lambdaByDate: entryCoverage.spec.byDate,
    }];
    const intermediateDates = database.chainDates(
        args.symbol, spec.entry, spec.front
    ).filter(date => date > spec.entry && date < spec.front);
    for (const replayDate of intermediateDates) {
        const replaySpot = database.closePrice(args.symbol, replayDate);
        const replayRate = database.rate(replayDate);
        const replayRows = database.chain(args.symbol, replayDate, args.maxLambdaDte);
        if (!(replaySpot > 0) || !replayRate || !replayRows.length) {
            replayPath.push({ date: replayDate, status: 'missing_exact_snapshot' });
            continue;
        }
        const replayPairs = buildPairMap(replayRows, args.maxSpreadPct, false);
        const replayFarPair = exactPairForStrike(replayPairs, spec.back, selected.strike);
        const replayFrontPair = exactPairForStrike(replayPairs, spec.front, selected.strike);
        if (!replayFarPair) {
            replayPath.push({ date: replayDate, status: 'far_bbo_unavailable' });
            continue;
        }
        const replayLambda = computeStructuredLambda(runtime, {
            symbol: args.symbol,
            date: replayDate,
            spot: replaySpot,
            rate: replayRate.rate,
            rows: replayRows,
            maxSpreadPct: args.maxSpreadPct,
            maxDte: args.maxLambdaDte,
        });
        const replayAsOf = closeAsOf(runtime, replayDate);
        const replayCoverage = lambdaSpecForInterval(
            runtime, replayLambda.result, replayAsOf, farAsOf
        );
        if (!replayCoverage.ready) {
            replayPath.push({
                date: replayDate,
                status: 'structured_lambda_unavailable',
                lambdaStatus: replayCoverage.status,
                missingDates: replayCoverage.missingDates || [],
            });
            continue;
        }
        const replayProjection = projectAtTarget(runtime, {
            symbol: args.symbol,
            quoteDate: replayDate,
            targetDate: spec.front,
            farExpiry: spec.back,
            strike: selected.strike,
            quoteSpot: replaySpot,
            targetSpot,
            rate: replayRate.rate,
            farPair: replayFarPair,
            frontPair: replayFrontPair,
            entryDebit: selected.entryDebit,
            lambdaCoverage: replayCoverage,
        });
        replayPath.push(replayProjection.ready ? {
            date: replayDate,
            status: 'ok',
            horizonCalendarDays: calendarDays(replayDate, spec.front),
            forecastPnl: replayProjection.projectedPnl,
            error: replayProjection.projectedPnl - paperPnl,
            absError: Math.abs(replayProjection.projectedPnl - paperPnl),
            forecastFar: replayProjection.projectedFar,
            localIv: replayProjection.localIv,
            lambdaStatus: replayCoverage.status,
            lambdaByDate: replayCoverage.spec.byDate,
        } : {
            date: replayDate,
            status: replayProjection.status,
        });
    }
    replayPath.push(boundaryProjection && boundaryProjection.ready ? {
        date: spec.front,
        status: 'ok',
        horizonCalendarDays: 0,
        forecastPnl: boundaryProjection.projectedPnl,
        error: boundaryError,
        absError: Math.abs(boundaryError),
        forecastFar: boundaryProjection.projectedFar,
        localIv: boundaryProjection.localIv,
        lambdaStatus: targetCoverage.status,
        lambdaByDate: targetCoverage.spec.byDate,
    } : {
        date: spec.front,
        status: targetCoverage.ready
            ? (boundaryProjection && boundaryProjection.status || 'boundary_unavailable')
            : 'structured_lambda_unavailable',
        lambdaStatus: targetCoverage.status,
        missingDates: targetCoverage.missingDates || [],
    });
    const priorSession = [...replayPath]
        .reverse()
        .find(item => item.date < spec.front && item.status === 'ok') || null;
    const clockBenchmarks = {
        structured: {
            forecastPnl: entryProjection.projectedPnl,
            error: entryError,
            absError: Math.abs(entryError),
        },
    };
    for (const [label, weight] of [['lambda0', 0], ['lambda0_3', 0.3], ['calendar1', 1]]) {
        const projection = projectAtTarget(runtime, {
            symbol: args.symbol,
            quoteDate: spec.entry,
            targetDate: spec.front,
            farExpiry: spec.back,
            strike: selected.strike,
            quoteSpot: entrySpot,
            targetSpot,
            rate: entryRate.rate,
            farPair: selected.back,
            frontPair: selected.front,
            entryDebit: selected.entryDebit,
            lambdaCoverage: counterfactualCoverage(entryCoverage, weight),
        });
        clockBenchmarks[label] = projection.ready ? {
            forecastPnl: projection.projectedPnl,
            error: projection.projectedPnl - paperPnl,
            absError: Math.abs(projection.projectedPnl - paperPnl),
        } : {
            status: projection.status,
        };
    }
    const farDiagnostic = entryLambda.result.rowDiagnostics.find(
        row => row.expiry === compactDate(spec.back)
    ) || null;
    const parityCarry = farDiagnostic && farDiagnostic.parityForward > 0
        ? Math.log(farDiagnostic.parityForward / entrySpot)
            / ((Date.parse(farAsOf) - Date.parse(entryLambda.quoteAsOf)) / DAY_MS / 365)
        : null;

    return {
        label: spec.label,
        status: 'ok',
        symbol: args.symbol,
        entry: spec.entry,
        front: spec.front,
        back: spec.back,
        strike: selected.strike,
        entrySpot,
        targetSpot,
        entryDebit: selected.entryDebit,
        targetIntrinsic: intrinsic,
        observedFarMid: exitFarMid,
        observedFarBid: exitFarBid,
        observedFarAsk: exitFarAsk,
        paperPnl,
        entryForecastPnl: entryProjection.projectedPnl,
        entryForecastFar: entryProjection.projectedFar,
        entryError,
        entryAbsError: Math.abs(entryError),
        entryForecastInsideExitBbo: entryProjection.projectedFar >= exitFarBid
            && entryProjection.projectedFar <= exitFarAsk,
        boundaryForecastPnl: boundaryProjection && boundaryProjection.ready
            ? boundaryProjection.projectedPnl : null,
        boundaryError,
        boundaryAbsError: boundaryError === null ? null : Math.abs(boundaryError),
        priorSessionDate: priorSession && priorSession.date || null,
        priorSessionForecastPnl: priorSession && priorSession.forecastPnl,
        priorSessionError: priorSession && priorSession.error,
        priorSessionAbsError: priorSession && priorSession.absError,
        replayPath,
        clockBenchmarks,
        entryLocalIv: entryProjection.localIv,
        boundaryLocalIv: boundaryProjection && boundaryProjection.ready
            ? boundaryProjection.localIv : null,
        entryClock: entryProjection.clocks,
        entryRate,
        targetRate,
        parityForward: farDiagnostic && farDiagnostic.parityForward || null,
        parityCarry,
        entryLambda: {
            median: entryLambda.result.medianLambda,
            quality: entryLambda.result.quality,
            required: entryCoverage.required,
            status: entryCoverage.status,
            requiredDates: entryCoverage.requiredDates,
            byDate: entryCoverage.spec.byDate,
        },
        targetLambda: {
            median: targetLambda.result.medianLambda,
            quality: targetLambda.result.quality,
            required: targetCoverage.required,
            status: targetCoverage.status,
            requiredDates: targetCoverage.requiredDates,
            missingDates: targetCoverage.missingDates,
            byDate: targetCoverage.spec && targetCoverage.spec.byDate || {},
        },
        dataQuality: {
            maxSelectedSpreadPct: selected.maxSpreadPct,
            exitFarHalfSpreadDollars: (exitFarAsk - exitFarBid) * 50,
            eodTimestampAssumption: '16:00 America/New_York',
            exactDateOnly: true,
        },
    };
}

function aggregate(results) {
    const usable = results.filter(item => item.status === 'ok');
    const mean = values => values.length
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : null;
    const median = values => {
        if (!values.length) return null;
        const sorted = [...values].sort((left, right) => left - right);
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2
            ? sorted[middle]
            : (sorted[middle - 1] + sorted[middle]) / 2;
    };
    const entryErrors = usable.map(item => item.entryError);
    const priorErrors = usable.map(item => item.priorSessionError).filter(Number.isFinite);
    const boundaryErrors = usable.map(item => item.boundaryError).filter(Number.isFinite);
    const clockBenchmarkMae = {};
    for (const label of ['structured', 'lambda0', 'lambda0_3', 'calendar1']) {
        const errors = usable
            .map(item => item.clockBenchmarks && item.clockBenchmarks[label]
                && item.clockBenchmarks[label].error)
            .filter(Number.isFinite);
        clockBenchmarkMae[label] = {
            count: errors.length,
            meanAbsoluteError: mean(errors.map(Math.abs)),
            meanError: mean(errors),
        };
    }
    return {
        requested: results.length,
        usable: usable.length,
        skipped: results.length - usable.length,
        entryForecast: {
            meanError: mean(entryErrors),
            meanAbsoluteError: mean(entryErrors.map(Math.abs)),
            medianAbsoluteError: median(entryErrors.map(Math.abs)),
            insideExitBboCount: usable.filter(item => item.entryForecastInsideExitBbo).length,
        },
        priorSessionForecast: {
            count: priorErrors.length,
            meanAbsoluteError: mean(priorErrors.map(Math.abs)),
            medianAbsoluteError: median(priorErrors.map(Math.abs)),
        },
        targetBoundary: {
            count: boundaryErrors.length,
            meanAbsoluteError: mean(boundaryErrors.map(Math.abs)),
            maxAbsoluteError: boundaryErrors.length
                ? Math.max(...boundaryErrors.map(Math.abs))
                : null,
        },
        researchClockBenchmarks: clockBenchmarkMae,
    };
}

function fmt(value, decimals = 2) {
    return Number.isFinite(value) ? Number(value).toFixed(decimals) : '--';
}

function printReport(report) {
    console.log('Historical EOD calendar projection validation');
    console.log('Production JS clock / IVTS lambda / local-BBO pricing path');
    console.log('');
    for (const item of report.cases) {
        if (item.status !== 'ok') {
            console.log(`SKIP  ${item.label}: ${item.reason}`);
            if (item.coverage && item.coverage.missingDates) {
                console.log(`      missing lambda: ${item.coverage.missingDates.join(', ')}`);
            }
            continue;
        }
        const lambdaText = item.entryLambda.required
            ? item.entryLambda.requiredDates
                .map(date => `${date}=${fmt(item.entryLambda.byDate[date], 4)}`).join(', ')
            : 'not_required';
        console.log(`${item.label}: ${item.entry} -> ${item.front} / ${item.back} K=${item.strike}`);
        console.log(
            `  paper P&L $${fmt(item.paperPnl)} | entry forecast $${fmt(item.entryForecastPnl)}`
            + ` | error $${fmt(item.entryError)}`
        );
        console.log(
            `  last usable replay ${item.priorSessionDate || '--'} error $${fmt(item.priorSessionError)}`
            + ` | boundary error $${fmt(item.boundaryError, 6)}`
        );
        console.log(
            `  far observed ${fmt(item.observedFarMid, 4)} [${fmt(item.observedFarBid, 4)}, ${fmt(item.observedFarAsk, 4)}]`
            + ` | entry forecast ${fmt(item.entryForecastFar, 4)}`
        );
        console.log(
            `  entry λ: ${lambdaText} | target λ: ${item.targetLambda.status}`
            + ` | r=${fmt(item.entryRate.rate * 100, 3)}% (${item.entryRate.effectiveDate})`
        );
        console.log(
            `  clock abs errors: structured $${fmt(item.clockBenchmarks.structured.absError)}`
            + ` | λ=0 $${fmt(item.clockBenchmarks.lambda0.absError)}`
            + ` | λ=0.3 $${fmt(item.clockBenchmarks.lambda0_3.absError)}`
            + ` | calendar $${fmt(item.clockBenchmarks.calendar1.absError)}`
        );
    }
    console.log('');
    console.log(
        `usable ${report.summary.usable}/${report.summary.requested}`
        + ` | entry MAE $${fmt(report.summary.entryForecast.meanAbsoluteError)}`
        + ` | prior-session MAE $${fmt(report.summary.priorSessionForecast.meanAbsoluteError)}`
        + ` | boundary max abs error $${fmt(report.summary.targetBoundary.maxAbsoluteError, 8)}`
    );
    console.log(
        `research clock MAE: structured $${fmt(report.summary.researchClockBenchmarks.structured.meanAbsoluteError)}`
        + ` | λ=0 $${fmt(report.summary.researchClockBenchmarks.lambda0.meanAbsoluteError)}`
        + ` | λ=0.3 $${fmt(report.summary.researchClockBenchmarks.lambda0_3.meanAbsoluteError)}`
        + ` | calendar $${fmt(report.summary.researchClockBenchmarks.calendar1.meanAbsoluteError)}`
    );
    console.log('EOD-only: no intraday timestamp, ES/FOP future, or settlement fixing exists in this database.');
}

function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) {
        console.log(usage());
        return 0;
    }
    if (!fs.existsSync(args.db)) throw new Error(`Options database not found: ${args.db}`);
    if (!fs.existsSync(args.ratesDb)) throw new Error(`Rates database not found: ${args.ratesDb}`);
    const runtime = loadProductionRuntime();
    const database = new HistoricalDatabase(args.db, args.ratesDb);
    let cases;
    try {
        cases = args.cases.map(spec => summarizeCase(runtime, database, args, spec));
    } finally {
        database.close();
    }
    const report = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        scope: 'historical_eod_calendar_projection',
        symbol: args.symbol,
        optionsDatabase: args.db,
        ratesDatabase: args.ratesDb,
        methodology: {
            pricingRuntime: [
                'js/date_utils.js',
                'js/iv_term_structure_core.js',
                'js/pricing_context.js',
                'js/pricing_core.js',
            ],
            quoteTimestampAssumption: '16:00 America/New_York',
            optionPriceSource: 'raw two-sided EOD BBO midpoint',
            nearLegAtTarget: 'intrinsic from underlying EOD close',
            noLookAhead: true,
            exactDateLookups: true,
        },
        cases,
        summary: aggregate(cases),
        limitations: [
            'EOD rows have no intraday quote timestamp.',
            'The database contains ETF options only; it has no ES/FOP futures or carry curve.',
            'Underlying close and option EOD BBO are not guaranteed to be one atomic snapshot.',
            'Entry forecast error includes actual future IV/skew/carry changes.',
            'The target-boundary identity check validates repricing integration, not execution slippage.',
        ],
    };
    printReport(report);
    if (args.json) {
        fs.writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        console.log(`Wrote ${args.json}`);
    }
    return report.summary.usable > 0 ? 0 : 1;
}

if (require.main === module) {
    try {
        process.exitCode = main();
    } catch (error) {
        console.error(error && error.stack || error);
        process.exitCode = 1;
    }
}

module.exports = {
    DEFAULT_CASES,
    parseArgs,
    bbo,
    buildPairMap,
    chooseLambdaAtmPairs,
    lambdaSpecForInterval,
    aggregate,
    main,
};
