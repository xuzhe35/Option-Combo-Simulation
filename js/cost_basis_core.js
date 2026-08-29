/**
 * Blended cost ledger — DOM-free core.
 *
 * Turns an append-only event stream into positions, three cost lenses, and
 * a TWS reconciliation diff. No DOM, no WebSocket, no timers, no clock
 * except the `today` the caller passes in: everything here is
 * deterministic and unit-tested in Node.
 *
 * Conventions that the rest of the feature depends on:
 *
 * - cashAmount is the account cash delta: positive received, negative paid,
 *   fees already inside it. Every total is a sum of stored cash, never a
 *   re-derivation of intent from a "kind".
 * - An assignment row's cash is the share delivery at the strike only. The
 *   premium was banked when the contract was opened, so counting it again
 *   here would double-count it.
 * - Premium is realized proportionally as a contract is closed, so a
 *   partial buy-back splits correctly between realized and still-at-risk.
 * - Nothing here writes: reconciliation produces *drafts* for a human to
 *   confirm, because an auto-written event corrupts the record silently.
 */

(function attachCostBasisCore(globalScope) {
    'use strict';

    // The only actions the ledger page may ever send. The page script routes
    // every outbound request through this list, so orders, market-data
    // subscriptions, and execution actions are structurally impossible.
    const ALLOWED_CLIENT_ACTIONS = Object.freeze([
        'request_cost_basis_status',
        'list_cost_basis_books',
        'create_cost_basis_book',
        'archive_cost_basis_book',
        'request_cost_basis_delete_plan',
        'delete_cost_basis_book',
        'list_cost_basis_events',
        'append_cost_basis_event',
        'void_cost_basis_event',
        'import_cost_basis_events',
        'save_cost_basis_snapshot',
        'list_cost_basis_snapshots',
        'request_cost_basis_reset_plan',
        'reset_cost_basis_book',
        'rebuild_cost_basis_book',
        'list_cost_basis_resets',
        // Read-only corroboration from the live backend. Both already exist
        // and neither subscribes to market data.
        'request_portfolio_positions_snapshot',
        'request_portfolio_avg_cost_snapshot',
        'request_managed_accounts_snapshot',
    ]);

    const EVENT_KINDS = Object.freeze([
        'opening_balance', 'share_trade', 'option_trade', 'option_assignment',
        'option_exercise', 'option_expiry', 'dividend', 'fee', 'split',
        'manual_adjust', 'futures_trade', 'futures_roll',
    ]);

    const OPTION_KINDS = Object.freeze([
        'option_trade', 'option_assignment', 'option_exercise', 'option_expiry',
    ]);

    const CLOSING_KINDS = Object.freeze([
        'option_assignment', 'option_exercise', 'option_expiry',
    ]);

    function _isClosingOptionEvent(event) {
        return CLOSING_KINDS.indexOf((event || {}).kind) >= 0
            || ((event || {}).kind === 'option_trade'
                && (event || {}).tag === 'ibkr_close');
    }

    function _closeOverdraws(position, contracts) {
        const current = _number(position);
        const change = _number(contracts);
        if (change > 0) return current > -change + SHARE_EPSILON;
        if (change < 0) return current < -change - SHARE_EPSILON;
        return true;
    }

    function _ibkrOpenOpposes(position, contracts) {
        const current = _number(position);
        const change = _number(contracts);
        return Math.abs(current) > SHARE_EPSILON
            && Math.abs(change) > SHARE_EPSILON
            && Math.sign(current) !== Math.sign(change);
    }

    const FUTURE_KINDS = Object.freeze(['futures_trade', 'futures_roll']);

    const BASIS_MODES = Object.freeze(['net_cash', 'stock_only', 'tax_adjusted']);

    const EPSILON = 1e-9;
    const SHARE_EPSILON = 1e-6;

    function _number(value) {
        const parsed = typeof value === 'number' ? value : parseFloat(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function _finiteOrNull(value) {
        if (value === null || value === undefined || value === '') return null;
        const parsed = typeof value === 'number' ? value : parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function _upper(value) {
        return String(value === null || value === undefined ? '' : value).trim().toUpperCase();
    }

    function _dateDigits(value) {
        return String(value === null || value === undefined ? '' : value).replace(/[^0-9]/g, '');
    }

    function _round(value, places) {
        const factor = Math.pow(10, places);
        return Math.round((value + Number.EPSILON) * factor) / factor;
    }

    /**
     * Identity of one option contract inside one account.
     *
     * The strike is rounded so a ledger row and a TWS snapshot land on the
     * same key despite float noise, and the deliverable size is part of the
     * key: an adjusted contract shares a strike and an expiry with the
     * standard one but delivers a different number of shares, so merging
     * them would blend two unrelated positions and their premium.
     *
     * conId is deliberately NOT the key. A ledger row typed by hand has no
     * conId while a TWS position always does, so keying on it would split
     * the very rows reconciliation exists to match. It is stored on the
     * event for audit instead.
     */
    function contractKey(descriptor) {
        const item = descriptor || {};
        const strike = _finiteOrNull(item.strike);
        const perContract = _finiteOrNull(
            item.sharesPerContract === undefined || item.sharesPerContract === null
                ? item.multiplier : item.sharesPerContract);
        return [
            String(item.account || ''),
            _upper(item.right).slice(0, 1),
            strike === null ? '' : strike.toFixed(4),
            _dateDigits(item.expiry || item.expDate).slice(0, 8),
            perContract === null ? '' : String(Math.abs(perContract)),
        ].join('|');
    }

    /** Structural identity of one FUT month inside one account. */
    function futureKey(descriptor, useRollTarget) {
        const item = descriptor || {};
        const target = useRollTarget === true;
        const expiry = target ? item.rollToExpiry : (item.futureExpiry || item.expDate);
        const multiplier = _finiteOrNull(
            item.sharesPerContract === undefined || item.sharesPerContract === null
                ? item.multiplier : item.sharesPerContract);
        return [
            String(item.account || ''),
            // IB/TWS may spell the same delivery month as YYYYMM or as the
            // contract's last-trade YYYYMMDD. Month is the structural key;
            // conId/localSymbol retain the exact broker identity.
            _dateDigits(expiry).slice(0, 6),
            multiplier === null ? '' : String(Math.abs(multiplier)),
        ].join('|');
    }

    /**
     * Resolve the broker identity inside each structural contract group.
     *
     * Structure remains the common denominator for hand-entered rows, but
     * two concrete IB contracts must never share one running position. An
     * unidentified row may join a concrete identity only when that identity
     * is unique inside the structural group; otherwise it stays in an
     * explicit ambiguous bucket and cannot silently close either contract.
     */
    function _buildIdentityResolution(items) {
        const groups = new Map();
        (Array.isArray(items) ? items : []).forEach((item) => {
            if (!item || (!item.right && OPTION_KINDS.indexOf(item.kind) < 0)) return;
            const structuralKey = contractKey(item);
            const conId = item.conId === null || item.conId === undefined
                || item.conId === '' ? '' : String(item.conId);
            const localSymbol = _upper(item.localSymbol);
            const group = groups.get(structuralKey) || {
                structuralKey,
                conIds: new Set(),
                localSymbols: new Set(),
                localToConIds: new Map(),
            };
            if (conId) group.conIds.add(conId);
            if (localSymbol) group.localSymbols.add(localSymbol);
            if (conId && localSymbol) {
                const mapped = group.localToConIds.get(localSymbol) || new Set();
                mapped.add(conId);
                group.localToConIds.set(localSymbol, mapped);
            }
            groups.set(structuralKey, group);
        });

        const byItem = new Map();
        (Array.isArray(items) ? items : []).forEach((item) => {
            if (!item || (!item.right && OPTION_KINDS.indexOf(item.kind) < 0)) return;
            const structuralKey = contractKey(item);
            const group = groups.get(structuralKey);
            const conId = item.conId === null || item.conId === undefined
                || item.conId === '' ? '' : String(item.conId);
            const localSymbol = _upper(item.localSymbol);
            let identity = '';
            let ambiguous = item.identityConflict === true;

            if (conId) {
                identity = `con:${conId}`;
            } else if (group.conIds.size) {
                const mapped = localSymbol && group.localToConIds.get(localSymbol);
                if (mapped && mapped.size === 1) {
                    identity = `con:${Array.from(mapped)[0]}`;
                } else if (!localSymbol && group.conIds.size === 1) {
                    // A truly identity-less manual row may use the only
                    // candidate. A row carrying a different localSymbol is
                    // evidence of another contract, not missing evidence
                    // about this one, and must remain fail-closed.
                    identity = `con:${Array.from(group.conIds)[0]}`;
                } else {
                    identity = localSymbol ? `ambiguous:${localSymbol}` : 'ambiguous';
                    ambiguous = true;
                }
            } else if (localSymbol) {
                identity = `local:${localSymbol}`;
            } else if (group.localSymbols.size === 1) {
                identity = `local:${Array.from(group.localSymbols)[0]}`;
            } else if (group.localSymbols.size > 1) {
                identity = 'ambiguous';
                ambiguous = true;
            }

            const groupConflict = group.conIds.size > 1
                || (group.conIds.size === 0 && group.localSymbols.size > 1);
            byItem.set(item, {
                structuralKey,
                identity,
                key: identity ? `${structuralKey}|#${identity}` : structuralKey,
                ambiguous,
                groupConflict,
            });
        });
        return { groups, byItem };
    }

    /**
     * The cash a row implies, or null when the kind has no derivation. One
     * formula covers both directions: selling five puts at 1.20 gives
     * contracts = -5 and therefore a positive cash amount.
     */
    function deriveCashAmount(event) {
        const item = event || {};
        const fees = _number(item.fees);
        const shares = _finiteOrNull(item.shares);
        const price = _finiteOrNull(item.price);
        const contracts = _finiteOrNull(item.contracts);
        const strike = _finiteOrNull(item.strike);
        const perContract = _finiteOrNull(item.sharesPerContract);

        switch (item.kind) {
            case 'share_trade':
            case 'opening_balance':
                if (shares === null || price === null) return null;
                return _round(-(shares * price) - fees, 6);
            case 'option_trade':
                if (contracts === null || price === null || !perContract) return null;
                return _round(-(contracts * perContract * price) - fees, 6);
            case 'option_assignment':
            case 'option_exercise':
                if (_upper(item.optionSecType) === 'FOP') {
                    return _round(-fees, 6);
                }
                if (shares === null || strike === null) return null;
                return _round(-(shares * strike) - fees, 6);
            case 'option_expiry':
                return _round(-fees, 6);
            case 'split':
                return 0;
            case 'futures_trade':
            case 'futures_roll':
                return _round(-fees, 6);
            default:
                return null;
        }
    }

    /**
     * Shares a delivery row moves, with the sign fixed by right and side.
     * Used to pre-fill drafts, never to override a stored value.
     */
    function deliveredShares(kind, right, contracts, sharesPerContract) {
        const magnitude = Math.abs(_number(contracts)) * Math.abs(_number(sharesPerContract));
        const rightCode = _upper(right).slice(0, 1);
        const acquires = kind === 'option_assignment' ? rightCode === 'P' : rightCode === 'C';
        return acquires ? magnitude : -magnitude;
    }

    function _emptyAccountState(account) {
        return {
            account,
            shares: 0,
            netCash: 0,
            optionPremiumNet: 0,
            realizedPremium: 0,
            openPremium: 0,
            shareAcquisitionCost: 0,
            shareDisposalProceeds: 0,
            dividends: 0,
            fees: 0,
            stockBasis: 0,
            stockRealized: 0,
            taxBasis: 0,
            taxRealized: 0,
            taxRealizedPremium: 0,
            contracts: new Map(),
            futures: new Map(),
            futuresRealizedPnl: 0,
            futuresFees: 0,
            futuresSettlementCash: 0,
            identityWarnings: new Set(),
            warnings: [],
        };
    }

    function _contractState(descriptor, resolved) {
        return {
            contracts: 0,
            openPremium: 0,
            realizedPremium: 0,
            right: _upper((descriptor || {}).right).slice(0, 1),
            strike: _finiteOrNull((descriptor || {}).strike),
            expiry: _dateDigits((descriptor || {}).expiry).slice(0, 8),
            sharesPerContract: _finiteOrNull((descriptor || {}).sharesPerContract),
            conIds: new Set(),
            localSymbols: new Set(),
            structuralKey: resolved ? resolved.structuralKey : contractKey(descriptor),
            identity: resolved ? resolved.identity : '',
            identityConflict: Boolean(resolved && resolved.ambiguous),
        };
    }

    /**
     * Watch a structural group for two genuinely different contracts.
     *
     * Structure - account, right, strike, expiry, deliverable size - is what
     * every source can supply, so it has to stay the grouping key: a
     * hand-typed row has no conId while a TWS position always does, and
     * keying on conId would split exactly the rows reconciliation exists to
     * match. But two different conIds under one structural key mean two real
     * contracts (SPX and SPXW can share a strike, an expiry and a
     * multiplier), and quietly netting them would blend unrelated positions.
     * They are flagged for a human instead of silently merged.
     */
    function _trackIdentity(contractState, event) {
        const conId = event.conId === null || event.conId === undefined
            || event.conId === '' ? '' : String(event.conId);
        const localSymbol = String(event.localSymbol || '').trim().toUpperCase();
        if (conId) contractState.conIds.add(conId);
        if (localSymbol) contractState.localSymbols.add(localSymbol);
        // Contract numbers decide when any row carries one. Rows that carry
        // none are simply less specific about the SAME contract - a
        // hand-typed row has no number while an imported one does - so they
        // must not be read as a second contract. Local symbols only arbitrate
        // when nothing better exists.
        contractState.identityConflict = contractState.identityConflict
            || contractState.conIds.size > 1
            || (contractState.conIds.size === 0
                && contractState.localSymbols.size > 1);
    }

    /**
     * Move a contract's position and split its premium between realized and
     * still-at-risk.
     *
     * A close realizes the same fraction of the accumulated premium as the
     * fraction of the position it closes, so buying back two of five short
     * puts realizes two fifths of the credit plus the whole debit it just
     * paid. Returns the premium realized by this row, which the tax lens
     * needs in order to roll an assignment's premium into the share basis.
     */
    function _applyContractRow(state, delta, premiumCash) {
        const prior = state.contracts;
        const magnitude = Math.abs(delta);
        let closing = 0;
        if (Math.abs(prior) > EPSILON && Math.sign(delta) === -Math.sign(prior)) {
            closing = Math.min(magnitude, Math.abs(prior));
        }

        let realizedThisRow = 0;
        if (closing > EPSILON && Math.abs(prior) > EPSILON) {
            const fraction = closing / Math.abs(prior);
            const slice = state.openPremium * fraction;
            state.openPremium -= slice;
            state.realizedPremium += slice;
            realizedThisRow += slice;
        }
        if (Math.abs(premiumCash) > EPSILON) {
            const closingShare = magnitude > EPSILON ? closing / magnitude : 0;
            const realizedPart = premiumCash * closingShare;
            state.realizedPremium += realizedPart;
            state.openPremium += premiumCash - realizedPart;
            realizedThisRow += realizedPart;
        }
        state.contracts = prior + delta;
        return realizedThisRow;
    }

    /**
     * Move a share lot through one lens, splitting the trade at zero.
     *
     * A single trade can close the whole position AND open the opposite one -
     * selling 200 when you hold 100 realizes a gain on 100 and shorts the
     * other 100. Treating it as one block would carry the old average into a
     * position it has nothing to do with, so the quantity that closes is
     * settled against the existing average and the remainder starts a fresh
     * position at this trade's own price. Fees follow the split pro rata.
     */
    function _applyShareLot(account, shares, price, fees, lens) {
        const basisKey = lens === 'tax' ? 'taxBasis' : 'stockBasis';
        const realizedKey = lens === 'tax' ? 'taxRealized' : 'stockRealized';
        const priorShares = account.shares;
        const magnitude = Math.abs(shares);
        if (magnitude <= SHARE_EPSILON) return;

        const opposes = Math.abs(priorShares) > SHARE_EPSILON
            && Math.sign(shares) === -Math.sign(priorShares);
        const closing = opposes ? Math.min(magnitude, Math.abs(priorShares)) : 0;
        const opening = magnitude - closing;
        const closingFees = fees * (closing / magnitude);
        const openingFees = fees - closingFees;

        if (closing > SHARE_EPSILON) {
            const average = account[basisKey] / priorShares;
            // Realized on the closed part, signed so that closing a short
            // profits when the buy-back price is below the average.
            const direction = priorShares > 0 ? 1 : -1;
            account[realizedKey] += direction * closing * (price - average) - closingFees;
            account[basisKey] -= average * closing * direction;
        }
        if (opening > SHARE_EPSILON) {
            const direction = Math.sign(shares);
            account[basisKey] += direction * opening * price + openingFees;
        }
    }

    function _inWindow(event, startDate, endDate) {
        const date = String(event.tradeDate || '');
        if (startDate && date < startDate) return false;
        if (endDate && date > endDate) return false;
        return true;
    }

    function _sortEvents(events) {
        return events.slice().sort((left, right) => {
            const leftDate = String(left.tradeDate || '');
            const rightDate = String(right.tradeDate || '');
            if (leftDate !== rightDate) return leftDate < rightDate ? -1 : 1;
            const leftTimestamp = String(
                left.brokerTimestamp || `${leftDate}T23:59:59`);
            const rightTimestamp = String(
                right.brokerTimestamp || `${rightDate}T23:59:59`);
            if (leftTimestamp !== rightTimestamp) {
                return leftTimestamp < rightTimestamp ? -1 : 1;
            }
            return _number(left.seq) - _number(right.seq);
        });
    }

    /**
     * Fold the event stream into per-account and combined state.
     *
     * options: { accounts, startDate, endDate, includeExcluded, referencePrice }
     * accounts = null means every account in the stream.
     */
    function computeLedger(events, options) {
        const opts = options || {};
        if (_upper(opts.secType) === 'FUT') {
            return _computeFuturesLedger(events, opts);
        }
        const accountFilter = Array.isArray(opts.accounts) && opts.accounts.length
            ? new Set(opts.accounts.map((item) => String(item)))
            : null;
        const startDate = String(opts.startDate || '');
        const endDate = String(opts.endDate || '');
        const includeExcluded = opts.includeExcluded === true;

        const accounts = new Map();
        const rows = [];
        const warnings = [];
        // When each slice of premium stopped being at risk, so an income
        // window can be built from realization dates rather than trade dates.
        const realizations = [];
        let runningShares = 0;
        let runningNetCash = 0;

        const ordered = _sortEvents(Array.isArray(events) ? events : []);
        const identityResolution = _buildIdentityResolution(ordered.filter((event) => {
            if (!event || event.voidedAtUtc || OPTION_KINDS.indexOf(event.kind) < 0) {
                return false;
            }
            const account = String(event.account || '');
            if (accountFilter && !accountFilter.has(account)) return false;
            if (!_inWindow(event, startDate, endDate)) return false;
            return event.includeInCost !== false || includeExcluded;
        })).byItem;
        ordered.forEach((event) => {
            if (!event || typeof event !== 'object') return;
            const account = String(event.account || '');
            if (accountFilter && !accountFilter.has(account)) return;
            if (!_inWindow(event, startDate, endDate)) return;

            if (event.voidedAtUtc) {
                // Excluded from every total, but kept in the flow: an audit
                // trail that hides its own corrections is not an audit trail,
                // and the export is the artefact someone reconciles against.
                rows.push({
                    event,
                    voided: true,
                    excluded: true,
                    runningShares,
                    runningNetCash,
                    runningCostPerShare: Math.abs(runningShares) > SHARE_EPSILON
                        ? _round(-runningNetCash / runningShares, 6)
                        : null,
                });
                return;
            }

            const excluded = event.includeInCost === false && !includeExcluded;
            // A split with no account applies to every account already in
            // scope. Creating a state for the empty account name would
            // invent a phantom account in every per-account view and in the
            // reconciliation table.
            const bookWideSplit = event.kind === 'split' && !account;
            let state = accounts.get(account);
            if (!state && !bookWideSplit) {
                state = _emptyAccountState(account);
                accounts.set(account, state);
            }

            if (!excluded) {
                const delta = bookWideSplit
                    ? _applySplit(Array.from(accounts.values()), event)
                    : _applyEventToAccount(
                        state, event, realizations, identityResolution);
                runningShares = _round(runningShares + delta, 6);
                runningNetCash = _round(runningNetCash + _number(event.cashAmount), 6);
            }

            rows.push({
                event,
                voided: false,
                excluded,
                runningShares,
                runningNetCash,
                runningCostPerShare: Math.abs(runningShares) > SHARE_EPSILON
                    ? _round(-runningNetCash / runningShares, 6)
                    : null,
            });
        });

        const perAccount = {};
        accounts.forEach((state, account) => {
            perAccount[account] = _finalizeAccount(state, opts);
        });
        const combined = _combineAccounts(Object.values(perAccount), opts);

        return {
            accounts: Array.from(accounts.keys()).sort(),
            perAccount,
            combined,
            rows,
            openOptions: _collectOpenOptions(accounts),
            realizations,
            warnings: warnings.concat(
                Array.from(accounts.values()).reduce(
                    (all, state) => all.concat(state.warnings), [])),
        };
    }

    function _futurePositionState(event, target) {
        const isTarget = target === true;
        const conId = isTarget ? event.rollToConId : event.futureConId;
        const localSymbol = _upper(
            isTarget ? event.rollToLocalSymbol : event.futureLocalSymbol);
        return {
            key: futureKey(event, isTarget),
            expiry: _dateDigits(
                isTarget ? event.rollToExpiry : event.futureExpiry).slice(0, 8),
            multiplier: Math.abs(_number(event.sharesPerContract)),
            contracts: 0,
            basisValue: 0,
            conIds: new Set(conId === null || conId === undefined || conId === ''
                ? [] : [String(conId)]),
            localSymbols: new Set(localSymbol ? [localSymbol] : []),
            identityConflict: false,
        };
    }

    function _trackFutureIdentity(position, event, target) {
        const isTarget = target === true;
        const rawConId = isTarget ? event.rollToConId : event.futureConId;
        const conId = rawConId === null || rawConId === undefined || rawConId === ''
            ? '' : String(rawConId);
        const localSymbol = _upper(
            isTarget ? event.rollToLocalSymbol : event.futureLocalSymbol);
        if (conId) position.conIds.add(conId);
        if (localSymbol) position.localSymbols.add(localSymbol);
        position.identityConflict = position.identityConflict
            || position.conIds.size > 1
            || (position.conIds.size === 0 && position.localSymbols.size > 1);
    }

    /** Apply one signed FUT fill and bank its gross realized price P&L. */
    function _applyFutureFill(account, event, delta, price, target) {
        const key = futureKey(event, target === true);
        const multiplier = Math.abs(_number(event.sharesPerContract));
        if (!key || !multiplier || !Number.isFinite(price)) {
            account.warnings.push(`future_identity_or_multiplier_missing:${key}`);
            return;
        }
        const position = account.futures.get(key)
            || _futurePositionState(event, target === true);
        account.futures.set(key, position);
        _trackFutureIdentity(position, event, target === true);
        if (position.identityConflict) {
            account.warnings.push(`future_identity_conflict:${key}`);
        }

        const prior = position.contracts;
        let remaining = _number(delta);
        if (Math.abs(prior) > EPSILON && Math.sign(remaining) === -Math.sign(prior)) {
            const closing = Math.min(Math.abs(prior), Math.abs(remaining));
            const average = position.basisValue / (prior * multiplier);
            const direction = Math.sign(prior);
            account.futuresRealizedPnl = _round(
                account.futuresRealizedPnl
                + direction * closing * multiplier * (price - average), 6);
            position.basisValue = _round(
                position.basisValue - direction * closing * multiplier * average, 6);
            position.contracts = _round(prior - direction * closing, 6);
            remaining = _round(remaining + direction * closing, 6);
            if (Math.abs(position.contracts) <= EPSILON) {
                position.contracts = 0;
                position.basisValue = 0;
            }
        }
        if (Math.abs(remaining) > EPSILON) {
            position.contracts = _round(position.contracts + remaining, 6);
            position.basisValue = _round(
                position.basisValue + remaining * multiplier * price, 6);
        }
    }

    function _applyFuturesEvent(account, event, realizations, identityResolution) {
        const kind = event.kind;
        const cash = _number(event.cashAmount);
        const fees = _number(event.fees);
        account.netCash = _round(account.netCash + cash, 6);
        account.fees = _round(account.fees + fees, 6);

        if (kind === 'fee' || kind === 'manual_adjust') {
            account.futuresSettlementCash = _round(
                account.futuresSettlementCash + cash, 6);
            return;
        }
        if (kind === 'futures_trade') {
            account.futuresFees = _round(account.futuresFees + fees, 6);
            _applyFutureFill(
                account, event, _number(event.futureContracts),
                _number(event.price), false);
            return;
        }
        if (kind === 'futures_roll') {
            const retained = _number(event.futureContracts);
            const old = account.futures.get(futureKey(event, false));
            if (!old || Math.sign(old.contracts) !== Math.sign(retained)
                || Math.abs(old.contracts) + EPSILON < Math.abs(retained)) {
                account.warnings.push(`roll_closes_more_than_open:${futureKey(event, false)}`);
            }
            account.futuresFees = _round(account.futuresFees + fees, 6);
            _applyFutureFill(account, event, -retained, _number(event.price), false);
            _applyFutureFill(
                account, event, retained, _number(event.rollToPrice), true);
            return;
        }
        if (OPTION_KINDS.indexOf(kind) < 0) return;

        const resolved = identityResolution.get(event) || {
            structuralKey: contractKey(event),
            identity: '',
            key: contractKey(event),
            ambiguous: false,
            groupConflict: false,
        };
        const key = resolved.key;
        const contractState = account.contracts.get(key)
            || _contractState(event, resolved);
        account.contracts.set(key, contractState);
        _trackIdentity(contractState, event);
        if (resolved.groupConflict || contractState.identityConflict) {
            account.warnings.push(`contract_identity_conflict:${resolved.structuralKey}`);
        }
        if (event.tag === 'prior_open') {
            const warning = `unknown_prior_open:${key}`;
            if (account.warnings.indexOf(warning) < 0) account.warnings.push(warning);
            // The headline must carry this, not just the warning list below
            // it: a bare number at the top of the page reads as a finished
            // answer, and a premium-less stub means it is not one.
            account.costIncomplete = true;
        }
        if (event.kind === 'option_trade' && event.tag === 'ibkr_open'
            && _ibkrOpenOpposes(contractState.contracts, event.contracts)) {
            account.warnings.push(`ibkr_open_opposes_existing:${key}`);
            return;
        }
        const mandatoryClose = _isClosingOptionEvent(event);
        if (mandatoryClose && _closeOverdraws(
            contractState.contracts, _number(event.contracts))) {
            account.warnings.push(`closes_more_than_open:${key}`);
            // A broker C row is evidence of a close, never permission to
            // create the opposite position.  The database rejects it; the
            // pure preview also fails closed instead of displaying a phantom
            // inverse position while the missing opening is being resolved.
            return;
        }
        const premiumCash = kind === 'option_trade' ? cash : 0;
        if (kind === 'option_trade') {
            account.optionPremiumNet = _round(account.optionPremiumNet + cash, 6);
        }
        const realized = _applyContractRow(
            contractState, _number(event.contracts), premiumCash);
        if (Math.abs(realized) > EPSILON) {
            realizations.push({
                tradeDate: String(event.tradeDate || ''),
                account: String(event.account || ''),
                key,
                amount: _round(realized, 6),
            });
        }
        if (kind !== 'option_trade') {
            account.futuresSettlementCash = _round(
                account.futuresSettlementCash + cash, 6);
        }
        if (kind === 'option_assignment' || kind === 'option_exercise') {
            _applyFutureFill(
                account, event, _number(event.futureContracts),
                _number(event.strike), false);
        }
    }

    function _futureTotals(account) {
        let contracts = 0;
        let exposure = 0;
        let basisValue = 0;
        const directions = new Set();
        account.futures.forEach((position) => {
            if (Math.abs(position.contracts) <= EPSILON) return;
            contracts += position.contracts;
            exposure += position.contracts * position.multiplier;
            basisValue += position.basisValue;
            directions.add(Math.sign(position.contracts));
        });
        return {
            contracts: _round(contracts, 6),
            exposure: _round(exposure, 6),
            basisValue: _round(basisValue, 6),
            mixedDirections: directions.size > 1,
        };
    }

    function _finalizeFuturesAccount(account, opts) {
        let realizedPremium = 0;
        let openPremium = 0;
        account.contracts.forEach((contractState) => {
            realizedPremium += contractState.realizedPremium;
            openPremium += contractState.openPremium;
        });
        const totals = _futureTotals(account);
        const economicNumerator = _round(
            totals.basisValue - account.futuresRealizedPnl + account.futuresFees
            - realizedPremium - account.futuresSettlementCash, 6);
        const available = !totals.mixedDirections
            && Math.abs(totals.exposure) > SHARE_EPSILON;
        const summary = {
            account: account.account,
            secType: 'FUT',
            shares: 0,
            futuresContracts: totals.contracts,
            futureExposure: totals.exposure,
            netCash: _round(account.netCash, 6),
            netCashOut: _round(-account.netCash, 6),
            optionPremiumNet: _round(account.optionPremiumNet, 6),
            realizedPremium: _round(realizedPremium, 6),
            openPremium: _round(openPremium, 6),
            fees: _round(account.fees, 6),
            futuresFees: _round(account.futuresFees, 6),
            futuresRealizedPnl: _round(account.futuresRealizedPnl, 6),
            futuresAvgCost: available
                ? _round(totals.basisValue / totals.exposure, 6) : null,
            blendedCost: available
                ? _round(economicNumerator / totals.exposure, 6) : null,
            blendedCostIfExpired: available
                ? _round((economicNumerator - openPremium) / totals.exposure, 6) : null,
            stockAvgCost: null,
            taxAvgCost: null,
            stockRealizedPnl: 0,
            taxRealizedPnl: 0,
            taxRealizedPremium: _round(realizedPremium, 6),
            dividends: 0,
            shareAcquisitionCost: 0,
            shareDisposalProceeds: 0,
            hasShares: false,
            hasFutures: available,
            isShort: totals.exposure < -SHARE_EPSILON,
            warnings: account.warnings.slice(),
            costIncomplete: account.costIncomplete === true,
            _futureBasisValue: totals.basisValue,
            _futureEconomicNumerator: economicNumerator,
            _mixedFutureDirections: totals.mixedDirections,
        };
        if (totals.mixedDirections) summary.warnings.push('mixed_future_directions');
        summary.breakEvenPrice = summary.blendedCost;
        summary.lifetimeNetCash = _round(
            account.futuresRealizedPnl - account.futuresFees
            + realizedPremium + account.futuresSettlementCash, 6);
        const reference = _finiteOrNull((opts || {}).referencePrice);
        summary.referencePrice = reference;
        summary.liquidationValue = null;
        summary.unrealizedStockPnl = null;
        summary.lifetimeNetIfLiquidated = reference !== null && available
            ? _round((reference - summary.blendedCost) * totals.exposure, 6) : null;
        return summary;
    }

    function _combineFuturesAccounts(summaries, opts) {
        const combined = {
            account: '', secType: 'FUT', shares: 0, futuresContracts: 0,
            futureExposure: 0, netCash: 0, netCashOut: 0, optionPremiumNet: 0,
            realizedPremium: 0, openPremium: 0, fees: 0, futuresFees: 0,
            futuresRealizedPnl: 0, futuresAvgCost: null, blendedCost: null,
            blendedCostIfExpired: null, stockAvgCost: null, taxAvgCost: null,
            stockRealizedPnl: 0, taxRealizedPnl: 0, taxRealizedPremium: 0,
            dividends: 0, shareAcquisitionCost: 0, shareDisposalProceeds: 0,
            hasShares: false, hasFutures: false, isShort: false, warnings: [],
            costIncomplete: false,
        };
        let basisValue = 0;
        let economicNumerator = 0;
        const directions = new Set();
        summaries.forEach((summary) => {
            combined.futuresContracts += summary.futuresContracts;
            combined.futureExposure += summary.futureExposure;
            combined.netCash += summary.netCash;
            combined.optionPremiumNet += summary.optionPremiumNet;
            combined.realizedPremium += summary.realizedPremium;
            combined.openPremium += summary.openPremium;
            combined.fees += summary.fees;
            combined.futuresFees += summary.futuresFees;
            combined.futuresRealizedPnl += summary.futuresRealizedPnl;
            combined.lifetimeNetCash = _number(combined.lifetimeNetCash)
                + _number(summary.lifetimeNetCash);
            combined.taxRealizedPremium += summary.taxRealizedPremium;
            basisValue += summary._futureBasisValue;
            economicNumerator += summary._futureEconomicNumerator;
            combined.warnings = combined.warnings.concat(summary.warnings);
            if (summary.costIncomplete) combined.costIncomplete = true;
            if (Math.abs(summary.futureExposure) > SHARE_EPSILON) {
                directions.add(Math.sign(summary.futureExposure));
            }
            if (summary._mixedFutureDirections) directions.add(2);
        });
        Object.keys(combined).forEach((key) => {
            if (typeof combined[key] === 'number') combined[key] = _round(combined[key], 6);
        });
        combined.netCashOut = _round(-combined.netCash, 6);
        const available = directions.size <= 1
            && Math.abs(combined.futureExposure) > SHARE_EPSILON;
        if (available) {
            combined.futuresAvgCost = _round(basisValue / combined.futureExposure, 6);
            combined.blendedCost = _round(economicNumerator / combined.futureExposure, 6);
            combined.blendedCostIfExpired = _round(
                (economicNumerator - combined.openPremium) / combined.futureExposure, 6);
        } else if (directions.size > 1) {
            combined.warnings.push('mixed_future_directions');
        }
        combined.hasFutures = available;
        combined.isShort = combined.futureExposure < -SHARE_EPSILON;
        combined.breakEvenPrice = combined.blendedCost;
        combined.lifetimeNetCash = _round(combined.lifetimeNetCash, 6);
        const reference = _finiteOrNull((opts || {}).referencePrice);
        combined.referencePrice = reference;
        combined.liquidationValue = null;
        combined.unrealizedStockPnl = null;
        combined.lifetimeNetIfLiquidated = reference !== null && available
            ? _round((reference - combined.blendedCost) * combined.futureExposure, 6)
            : null;
        return combined;
    }

    function _collectOpenFutures(accounts) {
        const rows = [];
        accounts.forEach((account, accountName) => {
            account.futures.forEach((position, key) => {
                if (Math.abs(position.contracts) <= EPSILON) return;
                rows.push({
                    key,
                    account: accountName,
                    expiry: position.expiry,
                    multiplier: position.multiplier,
                    sharesPerContract: position.multiplier,
                    contracts: _round(position.contracts, 6),
                    avgCost: _round(
                        position.basisValue
                        / (position.contracts * position.multiplier), 6),
                    conId: position.conIds.size === 1
                        ? Array.from(position.conIds)[0] : null,
                    localSymbol: position.localSymbols.size === 1
                        ? Array.from(position.localSymbols)[0] : '',
                    identityConflict: position.identityConflict,
                });
            });
        });
        return rows.sort((left, right) => (left.key < right.key ? -1 : 1));
    }

    function _computeFuturesLedger(events, opts) {
        const accountFilter = Array.isArray(opts.accounts) && opts.accounts.length
            ? new Set(opts.accounts.map((item) => String(item))) : null;
        const startDate = String(opts.startDate || '');
        const endDate = String(opts.endDate || '');
        const includeExcluded = opts.includeExcluded === true;
        const ordered = _sortEvents(Array.isArray(events) ? events : []);
        const optionEvents = ordered.filter((event) => event && !event.voidedAtUtc
            && OPTION_KINDS.indexOf(event.kind) >= 0);
        const identityResolution = _buildIdentityResolution(optionEvents).byItem;
        const accounts = new Map();
        const rows = [];
        const realizations = [];

        ordered.forEach((event) => {
            if (!event || typeof event !== 'object') return;
            const accountName = String(event.account || '');
            if (accountFilter && !accountFilter.has(accountName)) return;
            if (!_inWindow(event, startDate, endDate)) return;
            const excluded = event.includeInCost === false && !includeExcluded;
            let account = accounts.get(accountName);
            if (!account) {
                account = _emptyAccountState(accountName);
                accounts.set(accountName, account);
            }
            if (!event.voidedAtUtc && !excluded) {
                _applyFuturesEvent(account, event, realizations, identityResolution);
            }
            const summaries = Array.from(accounts.values()).map(
                (state) => _finalizeFuturesAccount(state, opts));
            const running = _combineFuturesAccounts(summaries, opts);
            rows.push({
                event,
                voided: Boolean(event.voidedAtUtc),
                excluded,
                runningShares: 0,
                runningFuturesContracts: running.futuresContracts,
                runningNetCash: running.netCash,
                // Match the STK flow column: it includes premium already
                // received on still-open options, i.e. the all-expire-zero lens.
                runningCostPerShare: running.blendedCostIfExpired,
                runningFuturesCost: running.blendedCostIfExpired,
            });
        });

        const perAccount = {};
        accounts.forEach((account, accountName) => {
            perAccount[accountName] = _finalizeFuturesAccount(account, opts);
        });
        const combined = _combineFuturesAccounts(Object.values(perAccount), opts);
        return {
            accounts: Array.from(accounts.keys()).sort(),
            perAccount,
            combined,
            rows,
            openOptions: _collectOpenOptions(accounts),
            openFutures: _collectOpenFutures(accounts),
            realizations,
            warnings: combined.warnings.slice(),
        };
    }

    /**
     * Multiply share counts by the ratio. Total dollars do not change across
     * a split, so both bases stay put and the average per share falls out
     * correctly on its own. Returns the share change, which the flow table's
     * running column needs.
     *
     * An option open across a split has terms the exchange adjusted in ways
     * this ledger cannot guess, so it is flagged for a human rather than
     * silently carried at its old strike and multiplier.
     */
    function _applySplit(targets, event) {
        const ratio = _number(event.splitRatio);
        if (!(ratio > 0)) {
            targets.forEach((target) => target.warnings.push('split_ratio_invalid'));
            return 0;
        }
        let delta = 0;
        targets.forEach((target) => {
            const before = target.shares;
            target.shares = _round(before * ratio, 6);
            delta += target.shares - before;
            target.contracts.forEach((contractState, key) => {
                if (Math.abs(contractState.contracts) > EPSILON) {
                    target.warnings.push(`split_crosses_open_option:${key}`);
                }
            });
        });
        return _round(delta, 6);
    }

    /** Apply one event to one account; returns its share delta. */
    function _applyEventToAccount(state, event, realizations, identityResolution) {
        const kind = event.kind;
        const cash = _number(event.cashAmount);
        const fees = _number(event.fees);
        const shares = _number(event.shares);
        const price = _finiteOrNull(event.price);
        const strike = _finiteOrNull(event.strike);
        const contracts = _number(event.contracts);

        state.netCash = _round(state.netCash + cash, 6);
        state.fees = _round(state.fees + fees, 6);

        if (kind === 'split') {
            return _applySplit([state], event);
        }

        if (kind === 'dividend') {
            state.dividends = _round(state.dividends + cash, 6);
            return 0;
        }
        if (kind === 'fee' || kind === 'manual_adjust') {
            return 0;
        }

        if (OPTION_KINDS.indexOf(kind) >= 0) {
            const resolved = identityResolution.get(event) || {
                structuralKey: contractKey(event),
                identity: '',
                key: contractKey(event),
                ambiguous: false,
                groupConflict: false,
            };
            const key = resolved.key;
            const contractState = state.contracts.get(key)
                || _contractState(event, resolved);
            state.contracts.set(key, contractState);
            _trackIdentity(contractState, event);
            if (resolved.groupConflict
                && !state.identityWarnings.has(resolved.structuralKey)) {
                state.identityWarnings.add(resolved.structuralKey);
                state.warnings.push(
                    `contract_identity_conflict:${resolved.structuralKey}`);
            }
            if (contractState.identityConflict
                && !state.identityWarnings.has(key)) {
                state.identityWarnings.add(key);
                state.warnings.push(`contract_identity_ambiguous:${key}`);
            }
            if (event.tag === 'prior_open') {
                const warning = `unknown_prior_open:${key}`;
                if (state.warnings.indexOf(warning) < 0) state.warnings.push(warning);
                state.costIncomplete = true;
            }
            if (kind === 'option_trade' && event.tag === 'ibkr_open'
                && _ibkrOpenOpposes(contractState.contracts, contracts)) {
                state.warnings.push(`ibkr_open_opposes_existing:${key}`);
                return 0;
            }

            const mandatoryClose = _isClosingOptionEvent(event);
            if (mandatoryClose && _closeOverdraws(contractState.contracts, contracts)) {
                state.warnings.push(`closes_more_than_open:${key}`);
                // See the FUT path above: a close that has no matching open
                // lot is incomplete history, not a new inverse position.
                return 0;
            }
            const premiumCash = kind === 'option_trade' ? cash : 0;
            if (kind === 'option_trade') {
                state.optionPremiumNet = _round(state.optionPremiumNet + cash, 6);
            }
            const realizedThisRow = _applyContractRow(contractState, contracts, premiumCash);
            if (realizations && Math.abs(realizedThisRow) > EPSILON) {
                realizations.push({
                    tradeDate: String(event.tradeDate || ''),
                    account: String(event.account || ''),
                    key,
                    amount: _round(realizedThisRow, 6),
                });
            }

            if (kind === 'option_assignment' || kind === 'option_exercise') {
                _applyDelivery(state, event, shares, strike, fees, realizedThisRow);
                return shares;
            }
            return 0;
        }

        if (kind === 'opening_balance' || kind === 'share_trade') {
            const effective = price === null ? 0 : price;
            _recordShareFlow(state, shares, effective, fees);
            _applyShareLot(state, shares, effective, fees, 'stock');
            _applyShareLot(state, shares, effective, fees, 'tax');
            state.shares = _round(state.shares + shares, 6);
            return shares;
        }
        return 0;
    }

    /**
     * Share delivery from an assignment or an exercise.
     *
     * The stock lens carries the shares at the strike, which is what a
     * broker's average-cost column shows. The tax lens rolls the contract's
     * premium into the basis instead: one rule covers all four cases,
     * because acquiring subtracts the per-share premium and disposing adds
     * it, and a long contract's premium is already negative.
     */
    function _applyDelivery(state, event, shares, strike, fees, realizedPremium) {
        const price = strike === null ? 0 : strike;
        const perContract = Math.abs(_number(event.sharesPerContract)) || 0;
        const closedShares = Math.abs(_number(event.contracts)) * perContract;
        const premiumPerShare = closedShares > SHARE_EPSILON
            ? realizedPremium / closedShares
            : 0;
        const effectiveTaxPrice = shares > 0
            ? price - premiumPerShare
            : price + premiumPerShare;

        _recordShareFlow(state, shares, price, fees);
        _applyShareLot(state, shares, price, fees, 'stock');
        _applyShareLot(state, shares, effectiveTaxPrice, fees, 'tax');
        // The premium is inside the share basis now, so counting it again as
        // option income would double it.
        state.taxRealizedPremium = _round(state.taxRealizedPremium - realizedPremium, 6);
        state.shares = _round(state.shares + shares, 6);
    }

    function _recordShareFlow(state, shares, price, fees) {
        if (shares > 0) {
            state.shareAcquisitionCost = _round(
                state.shareAcquisitionCost + shares * price + fees, 6);
        } else if (shares < 0) {
            state.shareDisposalProceeds = _round(
                state.shareDisposalProceeds + Math.abs(shares) * price - fees, 6);
        }
    }

    function _collectOpenOptions(accounts) {
        const open = [];
        accounts.forEach((state, account) => {
            state.contracts.forEach((contractState, key) => {
                if (Math.abs(contractState.contracts) <= EPSILON) return;
                open.push({
                    key,
                    structuralKey: contractState.structuralKey,
                    identity: contractState.identity,
                    account,
                    right: contractState.right,
                    strike: contractState.strike,
                    expiry: contractState.expiry,
                    sharesPerContract: contractState.sharesPerContract,
                    contracts: _round(contractState.contracts, 6),
                    openPremium: _round(contractState.openPremium, 6),
                    identities: (contractState.conIds.size
                        ? Array.from(contractState.conIds).map((id) => `con:${id}`)
                        : Array.from(contractState.localSymbols)).sort(),
                    conId: contractState.conIds.size === 1
                        ? Array.from(contractState.conIds)[0] : null,
                    localSymbol: contractState.localSymbols.size === 1
                        ? Array.from(contractState.localSymbols)[0] : '',
                    identityConflict: contractState.identityConflict === true,
                });
            });
        });
        return open.sort((left, right) => (left.key < right.key ? -1 : 1));
    }

    function _finalizeAccount(state, opts) {
        let realizedPremium = 0;
        let openPremium = 0;
        state.contracts.forEach((contractState) => {
            realizedPremium += contractState.realizedPremium;
            openPremium += contractState.openPremium;
        });
        // A negative balance is a supported final position, not an error in
        // the event that happened to cross zero first.  Settlement imports
        // often give every expiry/assignment row the same broker timestamp;
        // their arbitrary sequence must not leave a historical short warning
        // after later rows in that batch restore a long balance.
        if (state.shares < -SHARE_EPSILON
            && state.warnings.indexOf('net_short_shares') < 0) {
            state.warnings.push('net_short_shares');
        }
        const summary = {
            account: state.account,
            shares: _round(state.shares, 6),
            netCash: _round(state.netCash, 6),
            netCashOut: _round(-state.netCash, 6),
            optionPremiumNet: _round(state.optionPremiumNet, 6),
            realizedPremium: _round(realizedPremium, 6),
            openPremium: _round(openPremium, 6),
            shareAcquisitionCost: _round(state.shareAcquisitionCost, 6),
            shareDisposalProceeds: _round(state.shareDisposalProceeds, 6),
            dividends: _round(state.dividends, 6),
            fees: _round(state.fees, 6),
            stockAvgCost: null,
            stockRealizedPnl: _round(state.stockRealized, 6),
            taxAvgCost: null,
            taxRealizedPnl: _round(state.taxRealized, 6),
            taxRealizedPremium: _round(state.taxRealizedPremium + realizedPremium, 6),
            warnings: state.warnings.slice(),
            costIncomplete: state.costIncomplete === true,
        };
        if (Math.abs(summary.shares) > SHARE_EPSILON) {
            summary.stockAvgCost = _round(state.stockBasis / state.shares, 6);
            summary.taxAvgCost = _round(state.taxBasis / state.shares, 6);
        }
        _attachCostLenses(summary, opts);
        return summary;
    }

    function _combineAccounts(summaries, opts) {
        const combined = {
            account: '',
            shares: 0,
            netCash: 0,
            netCashOut: 0,
            optionPremiumNet: 0,
            realizedPremium: 0,
            openPremium: 0,
            shareAcquisitionCost: 0,
            shareDisposalProceeds: 0,
            dividends: 0,
            fees: 0,
            stockAvgCost: null,
            stockRealizedPnl: 0,
            taxAvgCost: null,
            taxRealizedPnl: 0,
            taxRealizedPremium: 0,
            warnings: [],
            costIncomplete: false,
        };
        let stockBasis = 0;
        let taxBasis = 0;
        summaries.forEach((summary) => {
            combined.shares = _round(combined.shares + summary.shares, 6);
            combined.netCash = _round(combined.netCash + summary.netCash, 6);
            combined.optionPremiumNet = _round(
                combined.optionPremiumNet + summary.optionPremiumNet, 6);
            combined.realizedPremium = _round(
                combined.realizedPremium + summary.realizedPremium, 6);
            combined.openPremium = _round(combined.openPremium + summary.openPremium, 6);
            combined.shareAcquisitionCost = _round(
                combined.shareAcquisitionCost + summary.shareAcquisitionCost, 6);
            combined.shareDisposalProceeds = _round(
                combined.shareDisposalProceeds + summary.shareDisposalProceeds, 6);
            combined.dividends = _round(combined.dividends + summary.dividends, 6);
            combined.fees = _round(combined.fees + summary.fees, 6);
            combined.stockRealizedPnl = _round(
                combined.stockRealizedPnl + summary.stockRealizedPnl, 6);
            combined.taxRealizedPnl = _round(
                combined.taxRealizedPnl + summary.taxRealizedPnl, 6);
            combined.taxRealizedPremium = _round(
                combined.taxRealizedPremium + summary.taxRealizedPremium, 6);
            combined.warnings = combined.warnings.concat(summary.warnings);
            if (summary.costIncomplete) combined.costIncomplete = true;
            if (summary.stockAvgCost !== null) {
                stockBasis += summary.stockAvgCost * summary.shares;
            }
            if (summary.taxAvgCost !== null) {
                taxBasis += summary.taxAvgCost * summary.shares;
            }
        });
        combined.netCashOut = _round(-combined.netCash, 6);
        if (Math.abs(combined.shares) > SHARE_EPSILON) {
            combined.stockAvgCost = _round(stockBasis / combined.shares, 6);
            combined.taxAvgCost = _round(taxBasis / combined.shares, 6);
        }
        _attachCostLenses(combined, opts);
        return combined;
    }

    /**
     * The three lenses, all off the same stored cash.
     *
     * `blendedCost` counts only premium that is no longer at risk;
     * `blendedCostIfExpired` assumes every open contract expires worthless.
     * Both may be negative, and a negative number means the position has
     * already returned more cash than it consumed - it is a result, not an
     * error, and callers must render it as one.
     */
    function _attachCostLenses(summary, opts) {
        const options = opts || {};
        const shares = summary.shares;
        const hasShares = Math.abs(shares) > SHARE_EPSILON;
        const conservativeCashOut = _round(summary.netCashOut + summary.openPremium, 6);

        summary.hasShares = hasShares;
        summary.isShort = shares < -SHARE_EPSILON;
        summary.conservativeNetCashOut = conservativeCashOut;
        summary.blendedCost = hasShares ? _round(conservativeCashOut / shares, 6) : null;
        summary.blendedCostIfExpired = hasShares
            ? _round(summary.netCashOut / shares, 6)
            : null;
        summary.breakEvenPrice = summary.blendedCost;
        summary.lifetimeNetCash = summary.netCash;

        const reference = _finiteOrNull(options.referencePrice);
        summary.referencePrice = reference;
        summary.liquidationValue = reference !== null ? _round(shares * reference, 6) : null;
        summary.lifetimeNetIfLiquidated = reference !== null
            ? _round(shares * reference + summary.netCash, 6)
            : null;
        summary.unrealizedStockPnl = (reference !== null && summary.stockAvgCost !== null)
            ? _round((reference - summary.stockAvgCost) * shares, 6)
            : null;
    }

    /**
     * Render one lens for display, naming the cases a bare number hides.
     *
     * A zero-share ledger has no per-share cost at all - what it has is a
     * cumulative signed cash balance - and a negative cost on a long position
     * means the money is already back. Both need a label, not a number.
     */
    function summarizeCost(summary, mode) {
        const basisMode = BASIS_MODES.indexOf(mode) >= 0 ? mode : 'net_cash';
        // EVERY path reports this. A closed-out book still shows cumulative
        // net cash at the top of the page, and that figure is just as
        // wrong as a per-share cost when a premium-less stub is behind it -
        // which is exactly the shape a fully-closed prior position leaves.
        const incomplete = Boolean(summary && summary.costIncomplete === true);
        if (!summary) {
            return {
                available: false, state: 'no_data', value: null,
                mode: basisMode, costIncomplete: false,
            };
        }
        if (summary.secType === 'FUT') {
            if (!summary.hasFutures) {
                return {
                    available: false,
                    state: 'no_futures',
                    value: null,
                    mode: basisMode,
                    lifetimeNetCash: summary.lifetimeNetCash,
                    costIncomplete: incomplete,
                };
            }
            const futureValue = basisMode === 'stock_only'
                ? summary.futuresAvgCost : summary.blendedCost;
            if (futureValue === null || futureValue === undefined) {
                return {
                    available: false, state: 'no_data', value: null,
                    mode: basisMode, costIncomplete: incomplete,
                };
            }
            return {
                available: true,
                state: summary.isShort ? 'short'
                    : (futureValue < 0 ? 'recovered' : 'normal'),
                value: futureValue,
                mode: basisMode,
                costIncomplete: incomplete,
            };
        }
        if (!summary.hasShares) {
            return {
                available: false,
                state: 'no_shares',
                value: null,
                mode: basisMode,
                lifetimeNetCash: summary.lifetimeNetCash,
                costIncomplete: incomplete,
            };
        }
        let value;
        if (basisMode === 'stock_only') value = summary.stockAvgCost;
        else if (basisMode === 'tax_adjusted') value = summary.taxAvgCost;
        else value = summary.blendedCost;

        if (value === null || value === undefined) {
            return {
                available: false, state: 'no_data', value: null,
                mode: basisMode, costIncomplete: incomplete,
            };
        }
        let state = 'normal';
        if (summary.isShort) state = 'short';
        else if (value < 0) state = 'recovered';
        return {
            available: true,
            state,
            value,
            mode: basisMode,
            shares: summary.shares,
            // True when a premium-less prior_open stub is still in the book:
            // the figure is arithmetically consistent but not the real
            // blended cost, and callers must say so where they show it.
            costIncomplete: incomplete,
        };
    }

    // ------------------------------------------------------------------
    // Reconciliation against a TWS position snapshot
    // ------------------------------------------------------------------

    function _positionKey(item, fallbackMultiplier) {
        return contractKey({
            account: item.account,
            right: item.right,
            strike: item.strike,
            expiry: item.expDate || item.expiry,
            sharesPerContract: Math.abs(_number(item.multiplier)) || fallbackMultiplier,
        });
    }

    function _filterPositions(positions, symbol, bookSecType) {
        const wanted = _upper(symbol);
        const allowed = _upper(bookSecType) === 'FUT'
            ? new Set(['FOP', 'FUT']) : new Set(['STK', 'OPT']);
        return (Array.isArray(positions) ? positions : []).filter((item) => (
            item && _upper(item.symbol) === wanted
            && allowed.has(_upper(item.secType))
        ));
    }

    function _buildFuturesReconciliation(args) {
        const ledger = args.ledger || { perAccount: {}, openOptions: [], openFutures: [] };
        const symbol = _upper(args.symbol);
        const multiplier = _number(args.defaultSharesPerContract) || 1;
        const positions = _filterPositions(args.positions, symbol, 'FUT');
        const rows = [];

        function aggregateFutures(items, fromTws) {
            const result = new Map();
            (items || []).forEach((raw) => {
                const item = fromTws ? {
                    account: String(raw.account || ''),
                    futureExpiry: _dateDigits(raw.expDate || raw.expiry).slice(0, 8),
                    futureContracts: _number(raw.position),
                    sharesPerContract: Math.abs(_number(raw.multiplier)) || multiplier,
                    futureConId: raw.conId,
                    futureLocalSymbol: raw.localSymbol || '',
                    twsAvgCost: _finiteOrNull(raw.avgCostPerUnit),
                } : {
                    account: raw.account,
                    futureExpiry: raw.expiry,
                    futureContracts: raw.contracts,
                    sharesPerContract: raw.multiplier || raw.sharesPerContract,
                    futureConId: raw.conId,
                    futureLocalSymbol: raw.localSymbol,
                    identityConflict: raw.identityConflict,
                };
                const key = futureKey(item);
                const previous = result.get(key);
                const conIds = new Set(previous ? previous.conIds : []);
                if (item.futureConId !== null && item.futureConId !== undefined
                    && item.futureConId !== '') conIds.add(String(item.futureConId));
                result.set(key, Object.assign({}, previous || item, {
                    key,
                    futureContracts: _round(
                        _number(previous && previous.futureContracts)
                        + _number(item.futureContracts), 6),
                    conIds: Array.from(conIds),
                    identityConflict: Boolean(item.identityConflict || conIds.size > 1),
                    twsAvgCost: item.twsAvgCost || (previous && previous.twsAvgCost) || null,
                }));
            });
            return result;
        }

        const twsFutureItems = positions.filter((item) => _upper(item.secType) === 'FUT');
        const ledgerFutures = aggregateFutures(ledger.openFutures || [], false);
        const twsFutures = aggregateFutures(twsFutureItems, true);
        const futureKeys = new Set([...ledgerFutures.keys(), ...twsFutures.keys()]);
        Array.from(futureKeys).sort().forEach((key) => {
            const ours = ledgerFutures.get(key);
            const actual = twsFutures.get(key);
            const ledgerContracts = _number(ours && ours.futureContracts);
            const twsContracts = _number(actual && actual.futureContracts);
            const difference = _round(twsContracts - ledgerContracts, 6);
            const descriptor = actual || ours;
            let status = Math.abs(difference) <= SHARE_EPSILON ? 'match'
                : (ledgerContracts === 0 ? 'tws_only'
                    : (twsContracts === 0 ? 'ledger_only' : 'quantity_mismatch'));
            const identityConflict = Boolean(
                (ours && ours.identityConflict) || (actual && actual.identityConflict)
                || (ours && actual && ours.conIds.length && actual.conIds.length
                    && ours.conIds[0] !== actual.conIds[0]));
            if (identityConflict) status = 'identity_conflict';
            rows.push({
                kind: 'future', key, account: descriptor.account,
                label: `${symbol} ${descriptor.futureExpiry || ''} FUT`,
                futureExpiry: descriptor.futureExpiry,
                sharesPerContract: descriptor.sharesPerContract,
                futureConId: (actual && actual.futureConId)
                    || (ours && ours.futureConId) || null,
                futureLocalSymbol: (actual && actual.futureLocalSymbol)
                    || (ours && ours.futureLocalSymbol) || '',
                ledger: ledgerContracts, tws: twsContracts, difference, status,
                identityConflict, suggestion: null, confidence: null,
                twsAvgCost: (actual && actual.twsAvgCost) || null,
            });
        });

        const twsOptionItems = positions.filter((item) => _upper(item.secType) === 'FOP')
            .map((item) => ({
                account: String(item.account || ''), right: _upper(item.right).slice(0, 1),
                strike: _finiteOrNull(item.strike),
                expiry: _dateDigits(item.expDate || item.expiry).slice(0, 8),
                contracts: _number(item.position),
                sharesPerContract: Math.abs(_number(item.multiplier)) || multiplier,
                conId: item.conId, localSymbol: item.localSymbol || '',
                twsAvgCost: _finiteOrNull(item.avgCostPerUnit),
            }));
        function aggregateOptions(items) {
            const result = new Map();
            (items || []).forEach((item) => {
                const key = contractKey(item);
                const previous = result.get(key);
                const conIds = new Set(previous ? previous.conIds : []);
                if (item.conId !== null && item.conId !== undefined && item.conId !== '') {
                    conIds.add(String(item.conId));
                }
                result.set(key, Object.assign({}, previous || item, {
                    key,
                    contracts: _round(_number(previous && previous.contracts)
                        + _number(item.contracts), 6),
                    conIds: Array.from(conIds),
                    identityConflict: Boolean(item.identityConflict || conIds.size > 1),
                    twsAvgCost: item.twsAvgCost || (previous && previous.twsAvgCost) || null,
                }));
            });
            return result;
        }
        const ledgerOptions = aggregateOptions(ledger.openOptions || []);
        const twsOptions = aggregateOptions(twsOptionItems);
        const optionKeys = new Set([...ledgerOptions.keys(), ...twsOptions.keys()]);
        Array.from(optionKeys).sort().forEach((key) => {
            const ours = ledgerOptions.get(key);
            const actual = twsOptions.get(key);
            const ledgerContracts = _number(ours && ours.contracts);
            const twsContracts = _number(actual && actual.contracts);
            const difference = _round(twsContracts - ledgerContracts, 6);
            const descriptor = actual || ours;
            let status = Math.abs(difference) <= SHARE_EPSILON ? 'match'
                : (ledgerContracts === 0 ? 'tws_only'
                    : (twsContracts === 0 ? 'ledger_only' : 'quantity_mismatch'));
            const identityConflict = Boolean(
                (ours && ours.identityConflict) || (actual && actual.identityConflict)
                || (ours && actual && ours.conIds.length && actual.conIds.length
                    && ours.conIds[0] !== actual.conIds[0]));
            if (identityConflict) status = 'identity_conflict';
            rows.push({
                kind: 'option', optionSecType: 'FOP', key,
                account: descriptor.account, label: _describeOption(symbol, descriptor),
                right: descriptor.right, strike: descriptor.strike,
                expiry: descriptor.expiry,
                sharesPerContract: descriptor.sharesPerContract,
                conId: (actual && actual.conId) || (ours && ours.conId) || null,
                localSymbol: (actual && actual.localSymbol)
                    || (ours && ours.localSymbol) || '',
                ledger: ledgerContracts, tws: twsContracts, difference, status,
                identityConflict, suggestion: null, confidence: null,
                twsAvgCost: (actual && actual.twsAvgCost) || null,
            });
        });

        // A vanished FOP and a newly visible FUT can be the two sides of one
        // exercise/assignment.  A position snapshot proves only the current
        // quantities, not the historical event or its time, so never write a
        // delivery from this coincidence.  It is nevertheless enough to
        // block adopting the FUT as an independent baseline: doing only that
        // would leave the FOP permanently open in the ledger.
        const optionGaps = rows.filter((row) => row.kind === 'option'
            && row.status !== 'match' && row.status !== 'identity_conflict'
            && Math.abs(row.ledger) > SHARE_EPSILON);
        const futureGaps = rows.filter((row) => row.kind === 'future'
            && row.status !== 'match' && row.status !== 'identity_conflict');
        optionGaps.forEach((optionRow) => {
            const ledgerContracts = _number(optionRow.ledger);
            const twsContracts = _number(optionRow.tws);
            const isReduction = Math.abs(twsContracts) < Math.abs(ledgerContracts)
                && (Math.abs(twsContracts) <= SHARE_EPSILON
                    || Math.sign(twsContracts) === Math.sign(ledgerContracts));
            if (!isReduction) return;
            const reduced = _round(ledgerContracts - twsContracts, 6);
            const deliveryKind = ledgerContracts < 0
                ? 'option_assignment' : 'option_exercise';
            const expectedFuture = deliveredShares(
                deliveryKind, optionRow.right, reduced, 1);
            const candidates = futureGaps.filter((futureRow) => (
                futureRow.account === optionRow.account
                && Math.abs(_number(futureRow.difference) - expectedFuture)
                    <= SHARE_EPSILON
                && Math.abs(_number(futureRow.sharesPerContract)
                    - _number(optionRow.sharesPerContract)) <= SHARE_EPSILON));
            if (!candidates.length) return;
            optionRow.possibleDelivery = true;
            optionRow.advice = candidates.length === 1
                ? 'FOP 减少与 FUT 增加可能是同一次交割；导入 CSV '
                    + '或手工核实完整交割，不能只采信 FUT。'
                : '多个 FUT 差额都可能来自这个 FOP 交割，需用 CSV '
                    + '或手工记录确定唯一合约。';
            candidates.forEach((futureRow) => {
                futureRow.adoptionBlocked = true;
                futureRow.possibleDelivery = true;
                futureRow.advice = '该 FUT 差额可能由 FOP 交割产生；不能单独'
                    + '采信为开仓基线，请导入 CSV 或完整补录交割。';
            });
        });

        const accounts = Array.from(new Set(rows.map((row) => row.account))).sort();
        return {
            symbol, accounts, rows,
            mismatches: rows.filter((row) => row.status !== 'match'),
            balanced: rows.every((row) => row.status === 'match'),
            identityConflicts: rows.filter((row) => row.status === 'identity_conflict'),
        };
    }

    /** Compare current quantities only; a TWS snapshot is not trade history. */
    function buildReconciliation(input) {
        const args = input || {};
        if (_upper(args.secType) === 'FUT') return _buildFuturesReconciliation(args);
        const ledger = args.ledger || { perAccount: {}, openOptions: [] };
        const symbol = _upper(args.symbol);
        const today = String(args.today || '');
        const positions = _filterPositions(args.positions, symbol, 'STK');
        const defaultSharesPerContract = _number(args.defaultSharesPerContract) || 100;

        const twsShares = new Map();
        const twsShareAvgCost = new Map();
        const twsOptionItems = [];
        const seenAccounts = new Set();
        positions.forEach((item) => {
            const account = String(item.account || '');
            seenAccounts.add(account);
            if (_upper(item.secType) === 'STK') {
                twsShares.set(account, _number(twsShares.get(account)) + _number(item.position));
                const avgCost = _finiteOrNull(item.avgCostPerUnit);
                if (avgCost !== null && avgCost > 0) twsShareAvgCost.set(account, avgCost);
                return;
            }
            twsOptionItems.push({
                account,
                right: _upper(item.right).slice(0, 1),
                strike: _finiteOrNull(item.strike),
                expiry: _dateDigits(item.expDate || item.expiry).slice(0, 8),
                contracts: _number(item.position),
                sharesPerContract: Math.abs(_number(item.multiplier)) || defaultSharesPerContract,
                localSymbol: item.localSymbol || '',
                conId: item.conId === undefined ? null : item.conId,
                twsAvgCost: _finiteOrNull(item.avgCostPerUnit),
            });
        });

        const ledgerAccounts = Object.keys(ledger.perAccount || {});
        ledgerAccounts.forEach((account) => seenAccounts.add(account));
        const accounts = Array.from(seenAccounts).sort();

        const shareGap = new Map();
        const rows = [];
        accounts.forEach((account) => {
            const summary = (ledger.perAccount || {})[account];
            const ledgerShares = summary ? _number(summary.shares) : 0;
            const actualShares = _number(twsShares.get(account));
            const gap = _round(actualShares - ledgerShares, 6);
            shareGap.set(account, gap);
            rows.push({
                kind: 'shares',
                account,
                label: `${symbol} shares`,
                ledger: ledgerShares,
                tws: actualShares,
                difference: gap,
                status: Math.abs(gap) <= SHARE_EPSILON ? 'match' : 'quantity_mismatch',
                suggestion: null,
                confidence: null,
                twsAvgCost: twsShareAvgCost.get(account) || null,
            });
        });

        const ledgerOptionItems = Array.isArray(ledger.openOptions)
            ? ledger.openOptions : [];
        const identityResolution = _buildIdentityResolution(
            ledgerOptionItems.concat(twsOptionItems)).byItem;
        function aggregateOptions(items) {
            const aggregated = new Map();
            items.forEach((item) => {
                const resolved = identityResolution.get(item) || {
                    key: item.key || _positionKey(item, defaultSharesPerContract),
                    structuralKey: contractKey(item),
                    identity: '',
                    ambiguous: false,
                };
                const previous = aggregated.get(resolved.key);
                const itemTwsAvgCost = _finiteOrNull(item.twsAvgCost);
                const identities = new Set(previous ? previous.identities : []);
                if (item.conId !== null && item.conId !== undefined && item.conId !== '') {
                    identities.add(`con:${item.conId}`);
                } else if (item.localSymbol) {
                    identities.add(_upper(item.localSymbol));
                }
                aggregated.set(resolved.key, {
                    key: resolved.key,
                    structuralKey: resolved.structuralKey,
                    identity: resolved.identity,
                    account: item.account,
                    right: _upper(item.right).slice(0, 1),
                    strike: _finiteOrNull(item.strike),
                    expiry: _dateDigits(item.expiry || item.expDate).slice(0, 8),
                    contracts: _round(
                        _number(previous && previous.contracts)
                        + _number(item.contracts === undefined
                            ? item.position : item.contracts), 6),
                    sharesPerContract: Math.abs(_number(item.sharesPerContract
                        || item.multiplier)) || defaultSharesPerContract,
                    localSymbol: item.localSymbol || '',
                    conId: item.conId === undefined ? null : item.conId,
                    identities: Array.from(identities).sort(),
                    identityConflict: Boolean(
                        (previous && previous.identityConflict)
                        || item.identityConflict || resolved.ambiguous),
                    twsAvgCost: itemTwsAvgCost !== null && itemTwsAvgCost > 0
                        ? itemTwsAvgCost
                        : ((previous && previous.twsAvgCost) || null),
                });
            });
            return aggregated;
        }

        const openByKey = aggregateOptions(ledgerOptionItems);
        const twsOptions = aggregateOptions(twsOptionItems);

        const optionKeys = new Set([
            ...Array.from(openByKey.keys()),
            ...Array.from(twsOptions.keys()),
        ]);
        const optionRows = [];
        Array.from(optionKeys).sort().forEach((key) => {
            const ledgerOption = openByKey.get(key);
            const twsOption = twsOptions.get(key);
            const ledgerContracts = ledgerOption ? _number(ledgerOption.contracts) : 0;
            const actualContracts = twsOption ? _number(twsOption.contracts) : 0;
            const difference = _round(actualContracts - ledgerContracts, 6);
            const descriptor = ledgerOption || twsOption;
            const row = {
                kind: 'option',
                key,
                account: descriptor.account,
                label: _describeOption(symbol, descriptor),
                right: descriptor.right,
                strike: descriptor.strike,
                expiry: descriptor.expiry,
                sharesPerContract: (twsOption && twsOption.sharesPerContract)
                    || defaultSharesPerContract,
                conId: (twsOption && twsOption.conId)
                    || (ledgerOption && ledgerOption.conId) || null,
                localSymbol: (twsOption && twsOption.localSymbol)
                    || (ledgerOption && ledgerOption.localSymbol) || '',
                ledger: ledgerContracts,
                tws: actualContracts,
                difference,
                status: 'match',
                suggestion: null,
                confidence: null,
                advice: '',
                twsAvgCost: (twsOption && twsOption.twsAvgCost) || null,
            };
            if (Math.abs(difference) > SHARE_EPSILON) {
                row.status = ledgerContracts === 0
                    ? 'tws_only'
                    : (actualContracts === 0 ? 'ledger_only' : 'quantity_mismatch');
            }
            if (ledgerOption && ledgerOption.identityConflict) {
                // This row had no uniquely resolvable broker identity, so an
                // equal structural quantity would only be a coincidence.
                row.status = 'identity_conflict';
                row.identities = ledgerOption.identities;
            }
            if (twsOption && twsOption.identityConflict) {
                row.status = 'identity_conflict';
                row.identities = twsOption.identities;
            }
            optionRows.push(row);
        });

        // TWS absence cannot distinguish expiry, exercise/assignment, and a
        // non-zero early close.  Even a matching share delta can be an
        // independent stock trade.  Report the correlation, but never turn
        // it into a historical cash event.
        optionRows.forEach((row) => {
            if (row.status === 'match' || row.status === 'identity_conflict') return;
            if (row.ledger === 0) {
                row.advice = row.twsAvgCost
                    ? '账本无该持仓；可人工采信 TWS 当前均价为基线。'
                    : 'TWS 有持仓但无均价；请导入 CSV 或手工录入。';
                return;
            }
            const closed = _round(row.ledger - row.tws, 6);
            if (Math.abs(closed) <= SHARE_EPSILON) return;
            const isReduction = Math.abs(row.tws) < Math.abs(row.ledger)
                && (Math.abs(row.tws) <= SHARE_EPSILON
                    || Math.sign(row.tws) === Math.sign(row.ledger));
            if (!isReduction) {
                row.advice = '持仓数量增加或反向；TWS 快照不能补出其历史'
                    + '成交，请导入 CSV 或手工录入。';
                return;
            }
            const deliveryKind = row.ledger < 0 ? 'option_assignment' : 'option_exercise';
            const implied = deliveredShares(
                deliveryKind, row.right, closed, row.sharesPerContract);
            const gap = _number(shareGap.get(row.account));
            const expiryDigits = _dateDigits(row.expiry);
            const todayDigits = _dateDigits(today);
            const expired = expiryDigits && todayDigits && expiryDigits < todayDigits;
            const possibleDelivery = Math.abs(gap) > SHARE_EPSILON
                && Math.sign(implied) === Math.sign(gap)
                && Math.abs(implied - gap) <= SHARE_EPSILON;
            if (possibleDelivery) {
                row.advice = '期权减少与股份差额可能来自交割，但 TWS '
                    + '快照不证明历史现金流；请导入 CSV 或手工核实。';
            } else if (expired) {
                row.advice = '已过到期日但 TWS 缺失不能证明零现金作废；'
                    + '也可能早已有偿平仓，请导入 CSV 或手工核实。';
            } else {
                row.advice = expiryDigits && todayDigits && expiryDigits === todayDigits
                    ? '今日到期但尚未确认结算；请检查 TWS 成交或稍后重拉。'
                    : '合约尚未到期；请检查 TWS 持仓或补录平仓成交。';
            }
        });

        // A current share difference is likewise not a historical trade.
        rows.forEach((row) => {
            if (row.kind !== 'shares') return;
            const remaining = _number(shareGap.get(row.account));
            row.unexplained = remaining;
            if (Math.abs(remaining) > SHARE_EPSILON) {
                row.advice = Math.abs(row.ledger) <= SHARE_EPSILON && row.twsAvgCost
                    ? '账本无该持仓；可人工采信 TWS 当前均价为基线。'
                    : '股份差额只是当前状态；请导入 CSV 或手工录入真实成交。';
            }
        });

        const all = rows.concat(optionRows);
        return {
            symbol,
            accounts,
            rows: all,
            mismatches: all.filter((row) => row.status !== 'match' && row.status !== 'explained'),
            balanced: all.every(
                (row) => row.status === 'match' || row.status === 'explained'),
            identityConflicts: optionRows.filter(
                (row) => row.status === 'identity_conflict'),
        };
    }

    /**
     * Build a current-date baseline from a complete authoritative TWS-only
     * position. This deliberately handles only a whole missing position:
     * applying TWS's blended average cost to one missing slice of a partly
     * recorded position would invent that slice's historical premium.
     *
     * The caller still performs the explicit confirmed write. Returning
     * null keeps missing/invalid TWS cost evidence on the manual-review path.
     */
    function buildTwsAdoptionEvent(row, options) {
        const item = row || {};
        const opts = options || {};
        const tradeDate = _isoDate(opts.today);
        const snapshotTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/
            .test(String(opts.snapshotTimestamp || ''))
            ? String(opts.snapshotTimestamp) : '';
        const avgCost = _finiteOrNull(item.twsAvgCost);
        if (!tradeDate || avgCost === null || avgCost <= 0
            || Math.abs(_number(item.ledger)) > SHARE_EPSILON
            || Math.abs(_number(item.tws)) <= SHARE_EPSILON
            || item.adoptionBlocked) {
            return null;
        }

        let event = null;
        if (item.kind === 'option' && item.status === 'tws_only'
            && !item.identityConflict) {
            event = {
                kind: 'option_trade',
                tradeDate,
                account: String(item.account || ''),
                right: item.right,
                strike: item.strike,
                expiry: item.expiry,
                contracts: _number(item.tws),
                sharesPerContract: item.sharesPerContract,
                conId: item.conId,
                localSymbol: item.localSymbol,
                optionSecType: item.optionSecType || (_upper(opts.secType) === 'FUT'
                    ? 'FOP' : 'OPT'),
                price: avgCost,
                fees: 0,
                source: 'reconcile',
                tag: 'tws_snapshot',
                note: 'Adopted from an authoritative TWS position snapshot at '
                    + 'TWS average cost. TWS supplies no original trade date, so '
                    + 'this is a current-date opening baseline.',
            };
        } else if (item.kind === 'future' && item.status === 'tws_only'
            && !item.identityConflict) {
            event = {
                kind: 'futures_trade',
                tradeDate,
                account: String(item.account || ''),
                futureExpiry: item.futureExpiry,
                futureContracts: _number(item.tws),
                sharesPerContract: item.sharesPerContract,
                futureConId: item.futureConId,
                futureLocalSymbol: item.futureLocalSymbol,
                price: avgCost,
                fees: 0,
                source: 'reconcile',
                tag: 'tws_snapshot',
                note: 'Adopted from an authoritative TWS FUT position snapshot at '
                    + 'TWS average cost. TWS supplies no original trade date, so '
                    + 'this is a current-date opening baseline.',
            };
        } else if (item.kind === 'shares' && item.status === 'quantity_mismatch') {
            event = {
                kind: 'opening_balance',
                tradeDate,
                account: String(item.account || ''),
                shares: _number(item.tws),
                price: avgCost,
                fees: 0,
                source: 'reconcile',
                tag: 'tws_snapshot',
                note: 'Adopted from an authoritative TWS position snapshot at '
                    + 'TWS average cost. TWS supplies no original trade date, so '
                    + 'this is a current-date opening baseline.',
            };
        }
        if (!event) return null;
        if (snapshotTimestamp) {
            // A date alone cannot distinguish a same-day trade before the
            // snapshot from one made afterwards. Preserve local broker-time
            // ordering evidence in the immutable audit note.
            event.brokerTimestamp = snapshotTimestamp;
            event.note += ` Snapshot timestamp ${snapshotTimestamp}.`;
        }
        event.cashAmount = deriveCashAmount(event);
        return event;
    }

    function _describeOption(symbol, descriptor) {
        const strike = _finiteOrNull(descriptor.strike);
        return `${symbol} ${descriptor.expiry || ''} ${descriptor.right || ''}`
            + `${strike === null ? '' : strike}`;
    }

    function _draftDelivery(row, kind, contracts, shares, today) {
        return {
            kind,
            // Delivery normally lands on the expiry; an early assignment is
            // the exception, so the operator confirms the date either way.
            tradeDate: _deliveryDate(row.expiry, today),
            account: row.account,
            right: row.right,
            strike: row.strike,
            expiry: row.expiry,
            contracts,
            shares,
            sharesPerContract: row.sharesPerContract,
            conId: row.conId,
            localSymbol: row.localSymbol,
            price: row.strike,
            fees: 0,
            cashAmount: row.strike === null ? null : _round(-(shares * row.strike), 6),
            source: 'reconcile',
            note: 'Drafted from a TWS position difference; confirm the date and fees.',
        };
    }

    function _deliveryDate(expiry, today) {
        const expiryDigits = _dateDigits(expiry);
        const todayDigits = _dateDigits(today);
        if (expiryDigits && todayDigits && expiryDigits <= todayDigits) {
            return _isoDate(expiryDigits);
        }
        return todayDigits ? _isoDate(todayDigits) : '';
    }

    function _draftExpiry(row, contracts, today) {
        return {
            kind: 'option_expiry',
            tradeDate: _deliveryDate(row.expiry, today),
            account: row.account,
            right: row.right,
            strike: row.strike,
            expiry: row.expiry,
            contracts,
            sharesPerContract: row.sharesPerContract,
            conId: row.conId,
            localSymbol: row.localSymbol,
            fees: 0,
            cashAmount: 0,
            source: 'reconcile',
            note: 'Drafted from a TWS position difference; confirm it expired worthless.',
        };
    }

    function _draftOptionTrade(row, today) {
        return {
            kind: 'option_trade',
            tradeDate: _isoDate(today),
            account: row.account,
            right: row.right,
            strike: row.strike,
            expiry: row.expiry,
            contracts: row.difference,
            sharesPerContract: row.sharesPerContract,
            conId: row.conId,
            localSymbol: row.localSymbol,
            price: null,
            fees: 0,
            cashAmount: null,
            source: 'reconcile',
            note: 'TWS holds a contract the ledger does not; fill in the premium.',
        };
    }

    function _draftShareTrade(account, shares, today) {
        return {
            kind: 'share_trade',
            tradeDate: _isoDate(today),
            account,
            shares,
            price: null,
            fees: 0,
            cashAmount: null,
            source: 'reconcile',
            note: 'Share difference with no matching option; fill in the trade price.',
        };
    }

    function _isoDate(value) {
        const digits = _dateDigits(value);
        if (digits.length >= 8) {
            return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
        }
        return String(value || '');
    }

    /**
     * Closes in a batch that nothing backs, with the size of each gap.
     *
     * Importing a broker statement that starts mid-life is the normal case,
     * not an error: contracts opened before the statement period close
     * inside it, so the batch closes positions it never opened. The store
     * refuses such a batch outright (and it should - a stranded close makes
     * the cost silently wrong), so the preview has to find them first and
     * say exactly which contracts are missing their opening.
     *
     * `existingOpen` seeds the walk with what the ledger already holds, so
     * a second statement layered onto real history reports nothing.
     */
    function findUnbackedCloses(events, options) {
        const opts = options || {};
        const inputEvents = Array.isArray(events) ? events : [];
        const existing = Array.isArray(opts.existingOpen) ? opts.existingOpen : [];
        const identityResolution = _buildIdentityResolution(
            existing.concat(inputEvents)).byItem;
        const seeds = new Map();
        existing.forEach((item) => {
            const resolved = identityResolution.get(item);
            const key = resolved ? resolved.key : (item.key || contractKey(item));
            seeds.set(key, _round(_number(seeds.get(key)) + _number(item.contracts), 6));
        });

        const states = new Map();
        const gaps = new Map();
        _sortEvents(inputEvents).forEach((event) => {
            if (!event || OPTION_KINDS.indexOf(event.kind) < 0) return;
            if (event.voidedAtUtc) return;
            const resolved = identityResolution.get(event);
            const key = resolved ? resolved.key : contractKey(event);
            if (!states.has(key)) {
                states.set(key, { position: _number(seeds.get(key)) });
            }
            const state = states.get(key);
            const contracts = _number(event.contracts);

            if (CLOSING_KINDS.indexOf(event.kind) >= 0) {
                let deficit = 0;
                if (contracts > 0 && state.position > -contracts + EPSILON) {
                    deficit = contracts + state.position;
                    // Pretend the missing position was there so one gap is
                    // reported once instead of cascading into every later row.
                    state.position -= deficit;
                } else if (contracts < 0 && state.position < -contracts - EPSILON) {
                    deficit = -contracts - state.position;
                    state.position += deficit;
                }
                if (deficit > EPSILON) {
                    const existing = gaps.get(key);
                    if (existing) {
                        existing.missingContracts = _round(
                            existing.missingContracts
                            + (contracts > 0 ? -deficit : deficit), 6);
                    } else {
                        gaps.set(key, {
                            key,
                            account: String(event.account || ''),
                            right: event.right || '',
                            strike: _finiteOrNull(event.strike),
                            expiry: event.expiry || '',
                            conId: event.conId === undefined ? null : event.conId,
                            localSymbol: event.localSymbol || '',
                            sharesPerContract: _number(event.sharesPerContract)
                                || _number(opts.defaultSharesPerContract) || 100,
                            multiplierInKey: true,
                            // Signed the way the missing OPENING trade would be:
                            // a close that needed a short implies a short open.
                            missingContracts: _round(
                                contracts > 0 ? -deficit : deficit, 6),
                            firstDate: String(event.tradeDate || ''),
                        });
                    }
                }
            }
            state.position = _round(state.position + contracts, 6);
        });
        return Array.from(gaps.values()).sort(
            (left, right) => (left.key < right.key ? -1 : 1));
    }

    /**
     * Opening stubs that make an unbacked batch importable.
     *
     * The premium is genuinely unknown - it is not in this file - so the
     * stub carries zero and is tagged, never quietly invented. The position
     * arithmetic becomes correct and the cost stays visibly incomplete
     * until the earlier statement is imported or the premium is filled in.
     */
    function buildPriorOpenDrafts(gaps, options) {
        const opts = options || {};
        const tradeDate = String(opts.tradeDate || '');
        return (gaps || []).map((gap) => ({
            kind: 'option_trade',
            tradeDate,
            account: gap.account,
            right: gap.right,
            strike: gap.strike,
            expiry: gap.expiry,
            contracts: gap.missingContracts,
            sharesPerContract: gap.sharesPerContract,
            conId: gap.conId,
            localSymbol: gap.localSymbol,
            price: 0,
            fees: 0,
            cashAmount: 0,
            source: 'csv_import',
            tag: 'prior_open',
            note: 'Opened before this statement period; premium unknown, '
                + 'fill it in or import the earlier statement.',
        }));
    }

    /**
     * Premium that stopped being at risk inside a trailing window.
     *
     * Dated by REALIZATION, not by trade: a credit taken in on a contract
     * that is still open is money received but still exposed, and counting
     * it as income overstates every rate computed from it. A contract opened
     * in one window and closed in another therefore lands wholly in the
     * window that closed it, together with whatever it cost to close.
     */
    function realizedPremiumWindow(ledger, options) {
        const opts = options || {};
        const since = String(opts.since || '');
        const until = String(opts.until || '');
        const entries = (ledger && Array.isArray(ledger.realizations))
            ? ledger.realizations : [];
        let total = 0;
        entries.forEach((entry) => {
            const date = String(entry.tradeDate || '');
            if (since && date < since) return;
            if (until && date > until) return;
            total += _number(entry.amount);
        });
        return _round(total, 6);
    }

    globalScope.OptionComboCostBasisCore = {
        ALLOWED_CLIENT_ACTIONS,
        EVENT_KINDS,
        OPTION_KINDS,
        CLOSING_KINDS,
        FUTURE_KINDS,
        BASIS_MODES,
        contractKey,
        futureKey,
        deriveCashAmount,
        deliveredShares,
        computeLedger,
        summarizeCost,
        buildReconciliation,
        buildTwsAdoptionEvent,
        findUnbackedCloses,
        buildPriorOpenDrafts,
        realizedPremiumWindow,
    };
})(typeof window !== 'undefined' ? window : globalThis);
