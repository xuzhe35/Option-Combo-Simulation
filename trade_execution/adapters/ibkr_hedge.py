import asyncio

from ib_async import Contract, Order, Stock

from trade_execution.models import (
    HedgeOrderPreview,
    HedgeSubmitResult,
    HedgeValidationResult,
)
from trade_execution.order_tracking import (
    extract_trade_status_message,
    resolve_tracking,
    update_tracking_snapshot,
)


HEDGE_ORDER_FIELD_MAPPINGS = (
    ('action', 'orderAction'),
    ('totalQuantity', 'quantity'),
    ('orderType', 'orderType'),
    ('lmtPrice', 'limitPrice'),
    ('tif', 'timeInForce'),
)


def _build_hedge_contract_from_request(self, request):
    sec_type = self._normalize_symbol(request.sec_type)
    symbol = self._normalize_symbol(request.symbol)
    exchange = request.exchange or ''
    currency = request.currency or 'USD'

    if sec_type == 'STK':
        contract = Stock(symbol, exchange or 'SMART', currency)
        if not getattr(contract, 'secType', None):
            contract.secType = 'STK'
        return contract

    if sec_type == 'FUT':
        contract_month = self._to_contract_month(request.contract_month)
        if not contract_month:
            raise ValueError('FUT hedge orders require contractMonth.')
        return Contract(
            secType='FUT',
            symbol=symbol,
            lastTradeDateOrContractMonth=contract_month,
            exchange=exchange,
            currency=currency,
            multiplier=str(request.multiplier or ''),
        )

    raise ValueError(f"Unsupported hedge secType: {sec_type!r}")


def _validate_hedge_order_request(self, request):
    sec_type = self._normalize_symbol(request.sec_type)
    if sec_type not in {'STK', 'FUT'}:
        raise ValueError('Hedge orders currently support STK and FUT only.')

    if not self._normalize_symbol(request.symbol):
        raise ValueError('Hedge order symbol is required.')

    order_action = self._normalize_symbol(request.order_action)
    if order_action not in {'BUY', 'SELL'}:
        raise ValueError('Hedge order action must be BUY or SELL.')

    try:
        quantity = int(request.quantity)
    except (TypeError, ValueError):
        quantity = 0
    if quantity <= 0:
        raise ValueError('Hedge order quantity must be positive.')

    order_type = self._normalize_symbol(request.order_type)
    if order_type not in {'LMT', 'MKT'}:
        raise ValueError('Hedge order type must be LMT or MKT.')

    if order_type == 'LMT':
        try:
            limit_price = float(request.limit_price)
        except (TypeError, ValueError):
            limit_price = 0.0
        if limit_price <= 0:
            raise ValueError('LMT hedge orders require a positive limitPrice.')


async def _qualify_hedge_contract(self, request):
    contract = self._build_hedge_contract_from_request(request)
    self.logger.info(
        f"Validating hedge contract: hedgeId={request.hedge_id} "
        f"secType={request.sec_type} symbol={request.symbol}"
    )
    results = await self.ib.qualifyContractsAsync(contract)
    if not results or results[0] is None:
        raise ValueError(f"Failed to qualify hedge contract {request.sec_type} {request.symbol}.")
    return results[0]


def _build_hedge_order(self, request):
    self._validate_hedge_order_request(request)
    order = Order()
    order.action = self._normalize_symbol(request.order_action)
    order.orderType = self._normalize_symbol(request.order_type)
    order.totalQuantity = int(request.quantity)
    order.tif = self._resolve_time_in_force(request)
    order.transmit = True
    if order.orderType == 'LMT':
        order.lmtPrice = round(float(request.limit_price), 4)
    if str(request.account or '').strip():
        order.account = str(request.account).strip()
    return order


async def _build_hedge_order_from_request(
    self,
    request,
    operation_recovery_epoch=None,
):
    self._validate_hedge_order_request(request)
    qualified_contract = await self._qualify_hedge_contract(request)
    if operation_recovery_epoch is not None:
        self._require_current_ib_recovery_epoch(
            operation_recovery_epoch,
            'continue hedge qualification',
        )
    order = self._build_hedge_order(request)

    price_increment = None
    if order.orderType == 'LMT':
        # Reuse the same market-rule / min-tick resolution and quantization the combo
        # path uses, so a hedge limit price conforms to the contract's real price
        # increment (e.g. ES futures 0.25) instead of an assumed default. Keeping a
        # single source of truth means future tick-handling changes live in one place.
        price_increment = await self._resolve_contract_price_increment(
            qualified_contract,
            getattr(qualified_contract, 'exchange', '') or request.exchange or '',
            getattr(order, 'lmtPrice', None),
            self.default_price_increment,
        )
        if operation_recovery_epoch is not None:
            self._require_current_ib_recovery_epoch(
                operation_recovery_epoch,
                'continue hedge qualification',
            )
        order.lmtPrice = self._quantize_underlying_limit_price(
            order.lmtPrice,
            order.action,
            price_increment,
        )

    preview = HedgeOrderPreview(
        hedge_id=request.hedge_id,
        hedge_name=request.hedge_name,
        sec_type=getattr(qualified_contract, 'secType', '') or self._normalize_symbol(request.sec_type),
        symbol=getattr(qualified_contract, 'symbol', '') or self._normalize_symbol(request.symbol),
        local_symbol=getattr(qualified_contract, 'localSymbol', '') or getattr(qualified_contract, 'symbol', ''),
        exchange=getattr(qualified_contract, 'exchange', '') or request.exchange,
        currency=getattr(qualified_contract, 'currency', '') or request.currency,
        order_action=order.action,
        quantity=int(order.totalQuantity),
        order_type=order.orderType,
        limit_price=getattr(order, 'lmtPrice', None) if order.orderType == 'LMT' else None,
        time_in_force=order.tif,
        execution_mode=request.execution_mode or 'preview',
        account=str(getattr(order, 'account', '') or request.account or '').strip(),
        request_source=request.request_source or 'delta_hedge_manual',
        contract_month=getattr(qualified_contract, 'lastTradeDateOrContractMonth', '') or request.contract_month,
        multiplier=str(getattr(qualified_contract, 'multiplier', '') or request.multiplier or ''),
        con_id=getattr(qualified_contract, 'conId', None),
        current_net_delta=request.current_net_delta,
        projected_net_delta=request.projected_net_delta,
        target_lower=request.target_lower,
        target_upper=request.target_upper,
        price_increment=price_increment,
    )
    return {
        'contract': qualified_contract,
        'order': order,
        'preview': preview,
    }


def _register_hedge_order_context(
    self,
    websocket,
    request,
    contract,
    trade,
    preview,
    ib_recovery_epoch=None,
):
    order = getattr(trade, 'order', None)
    order_status = getattr(trade, 'orderStatus', None)
    context = {
        'websocket': websocket,
        'hedgeId': request.hedge_id,
        'hedgeName': request.hedge_name,
        'account': str(getattr(order, 'account', '') or request.account or '').strip() or None,
        'executionMode': request.execution_mode or 'submit',
        'requestSource': request.request_source or 'delta_hedge_manual',
        'contract': contract,
        'trade': trade,
        'secType': preview.sec_type,
        'symbol': preview.symbol,
        'localSymbol': preview.local_symbol,
        'exchange': preview.exchange,
        'currency': preview.currency,
        'conId': preview.con_id,
        'orderAction': preview.order_action,
        'quantity': preview.quantity,
        'orderType': preview.order_type,
        'limitPrice': preview.limit_price,
        'timeInForce': preview.time_in_force,
        'contractMonth': preview.contract_month,
        'multiplier': preview.multiplier,
        'orderId': getattr(order, 'orderId', None),
        'permId': getattr(order_status, 'permId', None),
        'status': getattr(order_status, 'status', None),
        'filled': getattr(order_status, 'filled', None),
        'remaining': getattr(order_status, 'remaining', None),
        'avgFillPrice': getattr(order_status, 'avgFillPrice', None),
        'lastFillPrice': getattr(order_status, 'lastFillPrice', None),
        'whyHeld': getattr(order_status, 'whyHeld', None),
        'mktCapPrice': getattr(order_status, 'mktCapPrice', None),
        'cancelRequested': False,
        'ibRecoveryEpoch': (
            self._ib_recovery_epoch
            if ib_recovery_epoch is None
            else int(ib_recovery_epoch)
        ),
    }
    if context['orderId'] is not None:
        self.hedge_orders_by_order_id[context['orderId']] = context
    if context['permId'] is not None:
        self.hedge_orders_by_perm_id[context['permId']] = context
    return context


def _resolve_hedge_order_tracking(self, order_id, perm_id):
    return resolve_tracking(
        self.hedge_orders_by_order_id,
        self.hedge_orders_by_perm_id,
        order_id,
        perm_id,
    )


def _on_hedge_order_status(self, trade):
    order = getattr(trade, 'order', None)
    order_status = getattr(trade, 'orderStatus', None)
    if order is None or order_status is None:
        return

    order_id = getattr(order, 'orderId', None)
    perm_id = getattr(order_status, 'permId', None)
    context = self._resolve_hedge_order_tracking(order_id, perm_id)
    if context is None:
        return

    update_tracking_snapshot(
        context,
        order=order,
        order_status=order_status,
        trade=trade,
        status_message=extract_trade_status_message(trade),
        order_field_mappings=HEDGE_ORDER_FIELD_MAPPINGS,
    )


def _cleanup_hedge_order_context(self, context):
    order_id = context.get('orderId')
    perm_id = context.get('permId')
    if order_id is not None:
        self.hedge_orders_by_order_id.pop(order_id, None)
    if perm_id is not None:
        self.hedge_orders_by_perm_id.pop(perm_id, None)


def _build_hedge_order_snapshot(self, context):
    return {
        'hedgeId': context.get('hedgeId'),
        'hedgeName': context.get('hedgeName'),
        'account': context.get('account'),
        'executionMode': context.get('executionMode'),
        'requestSource': context.get('requestSource'),
        'secType': context.get('secType'),
        'symbol': context.get('symbol'),
        'localSymbol': context.get('localSymbol'),
        'exchange': context.get('exchange'),
        'currency': context.get('currency'),
        'conId': context.get('conId'),
        'orderAction': context.get('orderAction'),
        'quantity': context.get('quantity'),
        'orderType': context.get('orderType'),
        'limitPrice': context.get('limitPrice'),
        'timeInForce': context.get('timeInForce'),
        'contractMonth': context.get('contractMonth'),
        'multiplier': context.get('multiplier'),
        'orderId': context.get('orderId'),
        'permId': context.get('permId'),
        'status': context.get('status'),
        'filled': context.get('filled'),
        'remaining': context.get('remaining'),
        'avgFillPrice': context.get('avgFillPrice'),
        'lastFillPrice': context.get('lastFillPrice'),
        'whyHeld': context.get('whyHeld'),
        'mktCapPrice': context.get('mktCapPrice'),
        'cancelRequested': bool(context.get('cancelRequested')),
    }


async def validate_hedge_order(self, websocket, request):
    self._validate_hedge_order_request(request)
    qualified_contract = await self._qualify_hedge_contract(request)
    self.logger.info(
        f"Hedge validation passed for hedgeId={request.hedge_id}: "
        f"secType={getattr(qualified_contract, 'secType', '')} "
        f"symbol={getattr(qualified_contract, 'symbol', '')} "
        f"conId={getattr(qualified_contract, 'conId', None)}"
    )
    return HedgeValidationResult(
        hedge_id=request.hedge_id,
        hedge_name=request.hedge_name,
        execution_mode=request.execution_mode or 'preview',
        valid=True,
        sec_type=getattr(qualified_contract, 'secType', '') or self._normalize_symbol(request.sec_type),
        symbol=getattr(qualified_contract, 'symbol', '') or self._normalize_symbol(request.symbol),
        local_symbol=getattr(qualified_contract, 'localSymbol', '') or getattr(qualified_contract, 'symbol', ''),
        con_id=getattr(qualified_contract, 'conId', None),
    )


async def preview_hedge_order(self, websocket, request):
    build_result = await self._build_hedge_order_from_request(request)
    contract = build_result['contract']
    order = build_result['order']
    preview = build_result['preview']
    what_if = None
    if hasattr(self.ib, 'whatIfOrderAsync'):
        self.logger.info(
            f"Running IB hedge what-if for hedgeId={request.hedge_id} "
            f"orderAction={order.action} qty={order.totalQuantity} orderType={order.orderType}"
        )
        try:
            what_if = await asyncio.wait_for(
                self.ib.whatIfOrderAsync(contract, order),
                timeout=self.what_if_timeout_seconds,
            )
        except asyncio.TimeoutError:
            self.logger.warning(
                f"IB hedge what-if timed out for hedgeId={request.hedge_id} after "
                f"{self.what_if_timeout_seconds:.1f}s; returning preview without what-if details"
            )
        except Exception as exc:
            self.logger.warning(
                f"IB hedge what-if failed for hedgeId={request.hedge_id}: {exc}; "
                f"returning preview without what-if details"
            )
    preview.what_if = self._serialize_what_if(what_if)
    self.logger.info(
        f"Hedge preview-ready hedgeId={request.hedge_id}: "
        f"secType={preview.sec_type} symbol={preview.symbol} "
        f"action={preview.order_action} qty={preview.quantity} "
        f"orderType={preview.order_type} limit={preview.limit_price}"
    )
    return preview


async def submit_hedge_order(self, websocket, request):
    operation_recovery_epoch = self._ib_recovery_epoch
    self._require_ib_operation_ready(
        operation_recovery_epoch,
        'start the hedge order submission',
    )
    if not str(request.account or '').strip():
        raise ValueError('Hedge live submit requires an explicit account.')
    build_result = await self._build_hedge_order_from_request(
        request,
        operation_recovery_epoch=operation_recovery_epoch,
    )
    contract = build_result['contract']
    order = build_result['order']
    preview = build_result['preview']
    self.logger.info(
        f"Submitting hedge order hedgeId={request.hedge_id}: "
        f"secType={preview.sec_type} symbol={preview.symbol} "
        f"action={order.action} qty={order.totalQuantity} "
        f"orderType={order.orderType} limit={getattr(order, 'lmtPrice', None)} "
        f"tif={order.tif} account={getattr(order, 'account', '') or ''}"
    )
    self._require_ib_operation_ready(
        operation_recovery_epoch,
        'place the hedge order',
    )
    trade = self.ib.placeOrder(contract, order)
    order_status = getattr(trade, 'orderStatus', None)
    status_message = extract_trade_status_message(trade)
    self._register_hedge_order_context(
        websocket,
        request,
        contract,
        trade,
        preview,
        ib_recovery_epoch=operation_recovery_epoch,
    )
    result = HedgeSubmitResult(
        preview=preview,
        order_id=getattr(getattr(trade, 'order', None), 'orderId', None),
        perm_id=getattr(order_status, 'permId', None),
        status=getattr(order_status, 'status', None),
        status_message=status_message or None,
    )
    self.logger.info(
        f"Hedge order submitted for hedgeId={request.hedge_id}: "
        f"orderId={result.order_id} permId={result.perm_id} "
        f"status={result.status} statusMessage={result.status_message!r}"
    )
    return result


async def cancel_hedge_order(self, websocket, raw_data):
    operation_recovery_epoch = self._ib_recovery_epoch
    self._require_ib_operation_ready(
        operation_recovery_epoch,
        'start the hedge-order cancellation',
    )
    try:
        order_id = int(raw_data.get('orderId')) if raw_data.get('orderId') not in (None, '') else None
    except (TypeError, ValueError):
        order_id = None
    try:
        perm_id = int(raw_data.get('permId')) if raw_data.get('permId') not in (None, '') else None
    except (TypeError, ValueError):
        perm_id = None

    context = self._resolve_hedge_order_tracking(order_id, perm_id)
    if context is None:
        raise ValueError('No hedge order is available to cancel.')

    self._adopt_or_verify_context_session(
        context,
        websocket,
        'Hedge order belongs to a different session.',
    )

    status = str(context.get('status') or '').strip()
    if self._is_terminal_order_status(status):
        raise ValueError(f'Cannot cancel hedge order after terminal broker status {status}.')

    trade = context.get('trade')
    order = getattr(trade, 'order', None) if trade is not None else None
    if order is None:
        raise ValueError('No live broker hedge order is available to cancel.')

    if context.get('cancelRequested'):
        return self._build_hedge_order_snapshot(context)

    reason = str(raw_data.get('reason') or 'manual_cancel').strip()
    context_recovery_epoch = context.get(
        'ibRecoveryEpoch',
        operation_recovery_epoch,
    )
    self._require_current_ib_recovery_epoch(
        context_recovery_epoch,
        'cancel the hedge order',
    )
    self._require_ib_operation_ready(
        operation_recovery_epoch,
        'cancel the hedge order',
    )
    self.ib.cancelOrder(order)
    context['cancelRequested'] = True
    context['status'] = 'PendingCancel'
    context['cancelReason'] = reason
    self.logger.info(
        f"Requested hedge order cancellation for hedgeId={context.get('hedgeId')} "
        f"orderId={context.get('orderId')} permId={context.get('permId')} "
        f"account={context.get('account') or ''} reason={reason}"
    )
    return self._build_hedge_order_snapshot(context)
