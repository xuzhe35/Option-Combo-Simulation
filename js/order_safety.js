/**
 * Shared, DOM-free safety helpers for every broker-facing order path.
 * Product-specific builders still own pricing and broker payload shape; this
 * layer owns canonical intent identity, preview binding, and position impact.
 */
(function attachOrderSafety(globalScope) {
    function _upper(value) {
        return String(value || '').trim().toUpperCase();
    }

    function _number(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function _checker() {
        return globalScope.OptionComboLegPositionCheck || null;
    }

    function contractKey(descriptor) {
        const checker = _checker();
        if (checker && typeof checker.contractKey === 'function') {
            return checker.contractKey(descriptor);
        }
        const item = descriptor || {};
        return [_upper(item.secType), _upper(item.symbol), String(item.contractMonth || ''), String(item.expDate || ''), _upper(item.right), String(item.strike || '')].join('|');
    }

    function buildHedgeIntent(state, recommendation) {
        const runtime = state && state.deltaHedge || {};
        const instrument = recommendation && recommendation.hedgeInstrument || runtime.hedgeInstrument || {};
        const side = _upper(recommendation && recommendation.side);
        const quantity = Math.abs(Math.round(_number(recommendation && recommendation.quantity)));
        const signedQuantity = side === 'SELL' ? -quantity : quantity;
        return {
            kind: 'single',
            source: 'delta_hedge',
            ownerType: 'delta_hedge',
            ownerId: String(runtime.hedgeId || ['delta_hedge', _upper(instrument.secType).toLowerCase(), _upper(instrument.symbol).toLowerCase(), instrument.contractMonth || 'spot'].join('_')),
            account: String(state && state.selectedLiveComboOrderAccount || '').trim(),
            orderType: _upper(runtime.orderType || recommendation && recommendation.orderType || 'LMT'),
            limitPrice: runtime.limitPrice == null ? null : Number(runtime.limitPrice),
            legs: [{
                id: 'hedge_leg',
                secType: _upper(instrument.secType),
                symbol: _upper(instrument.symbol),
                exchange: _upper(instrument.exchange || 'SMART'),
                currency: _upper(instrument.currency || 'USD'),
                contractMonth: String(instrument.contractMonth || '').trim(),
                multiplier: instrument.multiplier,
                deltaPerUnit: instrument.deltaPerUnit,
                pos: signedQuantity,
            }],
        };
    }

    function _hedgeAllocationNames(state, key, currentOwnerId) {
        return (Array.isArray(state && state.hedges) ? state.hedges : [])
            .filter((hedge) => hedge && String(hedge.id || '') !== String(currentOwnerId || '') && Math.abs(_number(hedge.pos)) > 0)
            .filter((hedge) => contractKey({
                secType: hedge.secType || 'STK',
                symbol: hedge.symbol,
                contractMonth: hedge.contractMonth,
            }) === key)
            .map((hedge) => `Hedge ${_upper(hedge.localSymbol || hedge.symbol)}`);
    }

    function analyzePositionImpact(intent, state) {
        const checker = _checker();
        if (!checker || typeof checker.findOrderReductions !== 'function') {
            return { available: false, warnings: [], blockingReason: 'Position safety checker is unavailable.' };
        }
        const rawWarnings = checker.findOrderReductions(
            intent && intent.legs,
            state,
            state && state.portfolioPositions || [],
            intent && intent.account,
            state && state.groups || [],
            intent && intent.ownerType === 'group' ? intent.ownerId : ''
        );
        const warnings = rawWarnings.map((warning) => ({
            ...warning,
            otherGroupNames: Array.from(new Set([
                ...(warning.otherGroupNames || []),
                ..._hedgeAllocationNames(state, warning.key, intent && intent.ownerId),
            ])),
        }));
        const available = state && state.portfolioPositionsConnected === true;
        return {
            available,
            warnings,
            blockingReason: available ? '' : 'The latest TWS position snapshot is unavailable.',
        };
    }

    function previewMatchesIntent(preview, intent) {
        const order = preview && typeof preview === 'object' ? preview : null;
        const leg = intent && Array.isArray(intent.legs) ? intent.legs[0] : null;
        if (!order || !intent || !leg) return false;
        const expectedSide = _number(leg.pos) < 0 ? 'SELL' : 'BUY';
        if (_upper(order.orderAction || order.side) !== expectedSide) return false;
        if (Math.abs(_number(order.quantity)) !== Math.abs(_number(leg.pos))) return false;
        if (_upper(order.secType) && _upper(order.secType) !== _upper(leg.secType)) return false;
        if (_upper(order.symbol) && _upper(order.symbol) !== _upper(leg.symbol)) return false;
        if (String(order.contractMonth || '').slice(0, 6) && String(order.contractMonth || '').slice(0, 6) !== String(leg.contractMonth || '').slice(0, 6)) return false;
        if (Number(order.multiplier) > 0 && Number(leg.multiplier) > 0 && Number(order.multiplier) !== Number(leg.multiplier)) return false;
        if (_upper(order.orderType) !== _upper(intent.orderType)) return false;
        if (_upper(intent.orderType) === 'LMT' && Number(order.limitPrice) !== Number(intent.limitPrice)) return false;
        if (String(order.account || '') && String(order.account || '') !== String(intent.account || '')) return false;
        return true;
    }

    globalScope.OptionComboOrderSafety = {
        contractKey,
        buildHedgeIntent,
        analyzePositionImpact,
        previewMatchesIntent,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
