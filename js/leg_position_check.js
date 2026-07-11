/**
 * Pure helpers for comparing workspace group legs with account-level TWS positions.
 * TWS positions are net by contract, so global checks aggregate duplicate contracts.
 */
(function attachLegPositionCheck(globalScope) {
    const EPSILON = 0.0001;

    function _upper(value) {
        return String(value || '').trim().toUpperCase();
    }

    function _date(value) {
        return String(value || '').replace(/[^0-9]/g, '').slice(0, 8);
    }

    function _number(value) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function _strike(value) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? String(Math.round(parsed * 10000) / 10000) : '';
    }

    function contractKey(descriptor) {
        const item = descriptor || {};
        const secType = _upper(item.secType);
        const symbol = _upper(item.symbol);
        if (secType === 'STK') {
            return `${secType}|${symbol}`;
        }
        if (secType === 'FUT') {
            return `${secType}|${symbol}|${_date(item.contractMonth || item.expDate).slice(0, 6)}`;
        }
        return [
            secType,
            symbol,
            _date(item.expDate || item.lastTradeDateOrContractMonth),
            _upper(item.right).slice(0, 1),
            _strike(item.strike),
        ].join('|');
    }

    function _label(descriptor) {
        const item = descriptor || {};
        if (item.localSymbol) return String(item.localSymbol);
        const secType = _upper(item.secType);
        if (secType === 'STK') return `${_upper(item.symbol)} STK`;
        if (secType === 'FUT') return `${_upper(item.symbol)} ${_date(item.contractMonth || item.expDate).slice(0, 6)} FUT`;
        return `${_upper(item.symbol)} ${_date(item.expDate)} ${_upper(item.right).slice(0, 1)}${_strike(item.strike)}`.trim();
    }

    function _groupLegRequests(group, state) {
        const builder = globalScope.OptionComboGroupOrderBuilder;
        if (!builder || typeof builder.buildGroupOrderLegRequests !== 'function') return [];
        const openLegs = (group && group.legs || []).filter((leg) => (
            leg && (leg.closePrice === null || leg.closePrice === '' || leg.closePrice === undefined)
        ));
        return builder.buildGroupOrderLegRequests({ ...group, legs: openLegs }, state, { intent: 'open' });
    }

    function aggregateExpected(groups, state) {
        const aggregated = new Map();
        (groups || []).forEach((group) => {
            _groupLegRequests(group, state).forEach((leg) => {
                const quantity = _number(leg.pos);
                if (Math.abs(quantity) < EPSILON) return;
                const key = contractKey(leg);
                const row = aggregated.get(key) || {
                    key,
                    label: _label(leg),
                    descriptor: leg,
                    expected: 0,
                    groupIds: [],
                    groupNames: [],
                };
                row.expected += quantity;
                if (!row.groupIds.includes(group.id)) row.groupIds.push(group.id);
                const name = String(group.name || group.id || 'Group');
                if (!row.groupNames.includes(name)) row.groupNames.push(name);
                aggregated.set(key, row);
            });
        });
        return aggregated;
    }

    function aggregateActual(items, account) {
        const selectedAccount = String(account || '').trim();
        const aggregated = new Map();
        (items || []).forEach((item) => {
            if (selectedAccount && String(item.account || '').trim() !== selectedAccount) return;
            const quantity = _number(item.position);
            if (Math.abs(quantity) < EPSILON) return;
            const key = contractKey(item);
            const row = aggregated.get(key) || {
                key,
                label: _label(item),
                descriptor: item,
                actual: 0,
            };
            row.actual += quantity;
            aggregated.set(key, row);
        });
        return aggregated;
    }

    function compare(groups, state, items, account) {
        const expected = aggregateExpected(groups, state);
        const actual = aggregateActual(items, account);
        const rows = [];
        expected.forEach((expectedRow, key) => {
            const actualRow = actual.get(key);
            const actualQuantity = actualRow ? actualRow.actual : 0;
            let status = 'matched';
            if (Math.abs(actualQuantity) < EPSILON) status = 'missing';
            else if (Math.sign(actualQuantity) !== Math.sign(expectedRow.expected)) status = 'opposite';
            else if (Math.abs(actualQuantity - expectedRow.expected) >= EPSILON) status = 'quantity_mismatch';
            rows.push({
                ...expectedRow,
                label: actualRow ? actualRow.label : expectedRow.label,
                actual: actualQuantity,
                status,
            });
        });
        return {
            account: String(account || '').trim(),
            checkedAt: new Date().toISOString(),
            rows,
            matched: rows.filter((row) => row.status === 'matched').length,
            issues: rows.filter((row) => row.status !== 'matched').length,
            ok: rows.length > 0 && rows.every((row) => row.status === 'matched'),
        };
    }

    function findOrderReductions(orderLegs, state, items, account, groups, currentGroupId) {
        const actual = aggregateActual(items, account);
        const otherExpected = aggregateExpected(
            (groups || []).filter((group) => String(group.id || '') !== String(currentGroupId || '')),
            state
        );
        const warnings = [];
        (orderLegs || []).forEach((leg) => {
            const delta = _number(leg.pos);
            if (Math.abs(delta) < EPSILON) return;
            const key = contractKey(leg);
            const current = actual.get(key);
            if (!current || Math.abs(current.actual) < EPSILON || Math.sign(current.actual) === Math.sign(delta)) return;
            const projected = current.actual + delta;
            const allocation = otherExpected.get(key);
            warnings.push({
                key,
                label: current.label || _label(leg),
                current: current.actual,
                orderDelta: delta,
                projected,
                reducedQuantity: Math.min(Math.abs(current.actual), Math.abs(delta)),
                reverses: Math.abs(delta) > Math.abs(current.actual) + EPSILON,
                otherGroupNames: allocation ? allocation.groupNames : [],
            });
        });
        return warnings;
    }

    globalScope.OptionComboLegPositionCheck = {
        contractKey,
        aggregateExpected,
        aggregateActual,
        compare,
        findOrderReductions,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
