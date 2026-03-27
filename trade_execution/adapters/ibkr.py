import asyncio
import logging
import time
from datetime import datetime
from math import gcd, isfinite
from decimal import Decimal, ROUND_FLOOR, ROUND_CEILING

from ib_async import ComboLeg, Contract, Order, Stock, TagValue

from trade_execution.adapters.base import BrokerExecutionAdapter
from trade_execution.models import ComboOrderPreview, ComboPreviewLeg, ComboSubmitResult, ComboValidationLeg, ComboValidationResult


class IbkrExecutionAdapter(BrokerExecutionAdapter):
    def __init__(
        self,
        ib,
        client_subscriptions,
        qualified_underlyings,
        supported_live_families,
        index_exchange_fallbacks,
        managed_reprice_threshold=0.01,
        managed_reprice_interval_seconds=2.0,
        managed_reprice_max_updates=12,
        managed_reprice_timeout_seconds=600.0,
        logger=None,
        emit_order_update=None,
    ):
        self.ib = ib
        self.client_subscriptions = client_subscriptions
        self.qualified_underlyings = qualified_underlyings
        self.supported_live_families = supported_live_families
        self.index_exchange_fallbacks = index_exchange_fallbacks
        self.logger = logger or logging.getLogger(__name__)
        self.emit_order_update = emit_order_update
        self.what_if_timeout_seconds = 4.0
        self.test_only_buy_factor = 0.2
        self.test_only_sell_factor = 5.0
        self.test_only_min_debit = 0.01
        self.test_only_small_credit_buffer = 0.5
        self.default_price_increment = 0.01
        self.managed_reprice_threshold = float(managed_reprice_threshold)
        self.managed_reprice_interval_seconds = float(managed_reprice_interval_seconds)
        self.managed_reprice_max_updates = int(managed_reprice_max_updates)
        self.managed_reprice_timeout_seconds = float(managed_reprice_timeout_seconds)
        self.managed_terminal_confirmation_seconds = 3.0
        self.managed_executions_by_order_id = {}
        self.managed_executions_by_perm_id = {}
        self.ib.orderStatusEvent += self._on_managed_order_status

    def _is_reasonable_numeric(self, value):
        return isinstance(value, (int, float)) and isfinite(value) and abs(value) < 1e100

    def _extract_market_price(self, ticker):
        price = ticker.marketPrice()
        if not (price == price and price > 0):
            if ticker.last == ticker.last and ticker.last > 0:
                price = ticker.last
            elif ticker.close == ticker.close and ticker.close > 0:
                price = ticker.close
            else:
                return None
        return price

    def _extract_option_mark(self, ticker):
        bid = ticker.bid
        ask = ticker.ask
        if bid and ask and bid == bid and ask == ask and bid > 0 and ask > 0:
            return round((bid + ask) / 2, 4)

        if hasattr(ticker, 'modelGreeks') and ticker.modelGreeks:
            opt_price = getattr(ticker.modelGreeks, 'optPrice', None)
            if opt_price is not None and opt_price == opt_price and opt_price > 0:
                return round(opt_price, 4)

        fallback = self._extract_market_price(ticker)
        return round(fallback, 4) if fallback is not None else None

    def _extract_quote_snapshot(self, ticker, sec_type):
        normalized_sec_type = self._normalize_symbol(sec_type)
        bid = getattr(ticker, 'bid', None)
        ask = getattr(ticker, 'ask', None)
        bid = round(float(bid), 4) if self._is_reasonable_numeric(bid) and bid > 0 else None
        ask = round(float(ask), 4) if self._is_reasonable_numeric(ask) and ask > 0 else None

        if normalized_sec_type in ('OPT', 'FOP'):
            mark = self._extract_option_mark(ticker)
        else:
            market_price = self._extract_market_price(ticker)
            mark = round(market_price, 4) if market_price is not None else None

        if mark is None and bid is not None and ask is not None:
            mark = round((bid + ask) / 2, 4)
        if mark is not None:
            if bid is None:
                bid = mark
            if ask is None:
                ask = mark

        if mark is None or bid is None or ask is None:
            return None

        return {
            'bid': bid,
            'ask': ask,
            'mark': mark,
        }

    def _normalize_symbol(self, value):
        return str(value or '').strip().upper()

    def _to_contract_month(self, value):
        cleaned = str(value or '').replace('-', '')
        return cleaned[:6]

    def _to_expiry(self, value):
        return str(value or '').replace('-', '')

    def _resolve_family_defaults(self, symbol):
        return self.supported_live_families.get(self._normalize_symbol(symbol))

    def _resolve_index_exchange_candidates(self, symbol, requested_exchange):
        normalized_symbol = self._normalize_symbol(symbol)
        requested = str(requested_exchange or '').strip()
        candidates = []

        if requested:
            candidates.append(requested)

        for exchange in self.index_exchange_fallbacks.get(normalized_symbol, ()):
            if exchange not in candidates:
                candidates.append(exchange)

        if '' not in candidates:
            candidates.append('')

        return candidates

    def _resolve_weekly_fop_trading_class(self, symbol, expiry, current_trading_class):
        defaults = self._resolve_family_defaults(symbol)
        if not defaults:
            return current_trading_class

        base_trading_class = current_trading_class or defaults.get('trading_class') or ''
        if not base_trading_class or len(base_trading_class) < 2:
            return base_trading_class

        try:
            expiry_date = datetime.strptime(expiry, '%Y%m%d')
        except (TypeError, ValueError):
            return base_trading_class

        weekday_suffix = {
            0: 'A',
            1: 'B',
            2: 'C',
            3: 'D',
        }.get(expiry_date.weekday())

        if weekday_suffix:
            return f"{base_trading_class[:-1]}{weekday_suffix}"
        return base_trading_class

    async def _qualify_underlying_future(self, symbol, contract_month, exchange, currency, multiplier):
        cache_key = (
            self._normalize_symbol(symbol),
            self._to_contract_month(contract_month),
            exchange or '',
            currency or 'USD',
            str(multiplier or ''),
        )
        if cache_key in self.qualified_underlyings:
            return self.qualified_underlyings[cache_key]

        future_contract = Contract(
            secType='FUT',
            symbol=cache_key[0],
            lastTradeDateOrContractMonth=cache_key[1],
            exchange=cache_key[2],
            currency=cache_key[3],
            multiplier=cache_key[4],
        )
        results = await self.ib.qualifyContractsAsync(future_contract)
        if not results or results[0] is None:
            return None

        self.qualified_underlyings[cache_key] = results[0]
        return results[0]

    def _build_contract_from_request(self, leg_request):
        sec_type = self._normalize_symbol(leg_request.sec_type)
        symbol = self._normalize_symbol(leg_request.symbol)
        exchange = leg_request.exchange or ''
        currency = leg_request.currency or 'USD'
        multiplier = str(leg_request.multiplier or '')
        trading_class = leg_request.trading_class or ''
        strike = leg_request.strike
        right = self._normalize_symbol(leg_request.right)
        expiry = self._to_expiry(leg_request.exp_date)
        contract_month = self._to_contract_month(leg_request.contract_month)
        trading_class = self._resolve_weekly_fop_trading_class(symbol, expiry, trading_class)

        if sec_type == 'STK':
            return Stock(symbol, exchange or 'SMART', currency)

        if sec_type == 'IND':
            return Contract(secType='IND', symbol=symbol, exchange=exchange, currency=currency)

        if sec_type == 'FUT':
            return Contract(
                secType='FUT',
                symbol=symbol,
                lastTradeDateOrContractMonth=contract_month,
                exchange=exchange,
                currency=currency,
                multiplier=multiplier,
            )

        if sec_type in ('OPT', 'FOP'):
            return Contract(
                secType=sec_type,
                symbol=symbol,
                lastTradeDateOrContractMonth=expiry or contract_month,
                strike=float(strike),
                right=right,
                exchange=exchange,
                currency=currency,
                multiplier=multiplier,
                tradingClass=trading_class,
            )

        raise ValueError(f"Unsupported secType in request: {sec_type!r}")

    def _describe_contract_request(self, leg_request):
        return f"{self._normalize_symbol(leg_request.sec_type) or 'UNKNOWN'} {self._normalize_symbol(leg_request.symbol) or '<missing>'}".strip()

    async def _qualify_one(self, contract, leg_request):
        sec_type = self._normalize_symbol(leg_request.sec_type)
        underlying_contract_month = ''

        if sec_type == 'FOP':
            underlying_contract_month = self._to_contract_month(leg_request.underlying_contract_month)
            if underlying_contract_month:
                defaults = self._resolve_family_defaults(leg_request.symbol)
                underlying_symbol = self._normalize_symbol(
                    leg_request.underlying_symbol
                    or (defaults or {}).get('underlying_symbol')
                    or leg_request.symbol
                )
                underlying_exchange = (
                    leg_request.underlying_exchange
                    or (defaults or {}).get('exchange')
                    or leg_request.exchange
                    or ''
                )
                underlying_currency = leg_request.currency or (defaults or {}).get('currency') or 'USD'
                underlying_multiplier = str(
                    leg_request.underlying_multiplier
                    or (defaults or {}).get('multiplier')
                    or leg_request.multiplier
                    or ''
                )
                qualified_underlying = await self._qualify_underlying_future(
                    underlying_symbol,
                    underlying_contract_month,
                    underlying_exchange,
                    underlying_currency,
                    underlying_multiplier,
                )
                if qualified_underlying is None:
                    self.logger.error(
                        f"Failed to qualify underlying FUT {underlying_symbol} {underlying_contract_month} "
                        f"for option {self._describe_contract_request(leg_request)}"
                    )
                    return None
                contract.underConId = qualified_underlying.conId

        results = await self.ib.qualifyContractsAsync(contract)
        if (not results or results[0] is None) and sec_type == 'IND':
            original_exchange = contract.exchange
            for candidate_exchange in self._resolve_index_exchange_candidates(contract.symbol, original_exchange):
                if candidate_exchange == original_exchange:
                    continue

                contract.exchange = candidate_exchange
                results = await self.ib.qualifyContractsAsync(contract)
                if results and results[0] is not None:
                    self.logger.info(
                        f"Qualified {self._describe_contract_request(leg_request)} using IND exchange fallback "
                        f"{candidate_exchange or '<blank>'} instead of {original_exchange or '<blank>'}"
                    )
                    break

        if (not results or results[0] is None) and sec_type == 'FOP' and underlying_contract_month and getattr(contract, 'tradingClass', ''):
            original_trading_class = contract.tradingClass
            contract.tradingClass = ''
            results = await self.ib.qualifyContractsAsync(contract)
            if results and results[0] is not None:
                self.logger.info(
                    f"Qualified {self._describe_contract_request(leg_request)} using underConId fallback "
                    f"without tradingClass {original_trading_class}"
                )

        if not results or results[0] is None:
            return None

        return results[0]

    async def _request_temporary_ticker(self, contract, generic_ticks=''):
        ticker = self.ib.reqMktData(contract, generic_ticks, False, False)
        await asyncio.sleep(0.75)
        return ticker

    def _resolve_existing_order_ticker(self, websocket, leg_request):
        subs = self.client_subscriptions.get(websocket, {})
        if leg_request.id and leg_request.id in subs:
            return subs[leg_request.id]

        if self._normalize_symbol(leg_request.sec_type) in ('STK', 'FUT', 'IND'):
            return subs.get('underlying')

        return None

    async def _resolve_leg_contract_and_mark(self, websocket, leg_request):
        contract = self._build_contract_from_request(leg_request)
        self.logger.info(
            f"Resolving combo leg market data: id={leg_request.id} "
            f"{self._describe_contract_request(leg_request)}"
        )
        qualified_contract = await self._qualify_one(contract, leg_request)
        if qualified_contract is None:
            raise ValueError(f"Failed to qualify {self._describe_contract_request(leg_request)}")

        ticker = self._resolve_existing_order_ticker(websocket, leg_request)
        created_temp_ticker = False
        if ticker is None:
            ticker = await self._request_temporary_ticker(
                qualified_contract,
                '106' if self._normalize_symbol(leg_request.sec_type) in ('OPT', 'FOP') else ''
            )
            created_temp_ticker = True

        try:
            sec_type = self._normalize_symbol(leg_request.sec_type)
            quote = self._extract_quote_snapshot(ticker, sec_type)
            if quote is None:
                raise ValueError(f"No live mark available for {self._describe_contract_request(leg_request)}")
            self.logger.info(
                f"Resolved combo leg: id={leg_request.id} conId={qualified_contract.conId} "
                f"localSymbol={getattr(qualified_contract, 'localSymbol', '')} "
                f"bid={quote['bid']} ask={quote['ask']} mark={quote['mark']}"
            )
            return qualified_contract, quote
        finally:
            if created_temp_ticker:
                try:
                    self.ib.cancelMktData(qualified_contract)
                except Exception:
                    pass

    async def _validate_leg_contract(self, leg_request):
        contract = self._build_contract_from_request(leg_request)
        self.logger.info(
            f"Validating combo leg contract: id={leg_request.id} "
            f"{self._describe_contract_request(leg_request)}"
        )
        qualified_contract = await self._qualify_one(contract, leg_request)
        if qualified_contract is None:
            raise ValueError(f"Failed to qualify {self._describe_contract_request(leg_request)}")
        return qualified_contract

    def _serialize_what_if(self, order_state):
        if order_state is None:
            return None

        numeric_fields = {
            'commission',
            'minCommission',
            'maxCommission',
            'initMarginBefore',
            'maintMarginBefore',
            'equityWithLoanBefore',
            'initMarginChange',
            'maintMarginChange',
            'equityWithLoanChange',
            'initMarginAfter',
            'maintMarginAfter',
            'equityWithLoanAfter',
        }
        field_names = [
            'status',
            'commission',
            'minCommission',
            'maxCommission',
            'commissionCurrency',
            'initMarginBefore',
            'maintMarginBefore',
            'equityWithLoanBefore',
            'initMarginChange',
            'maintMarginChange',
            'equityWithLoanChange',
            'initMarginAfter',
            'maintMarginAfter',
            'equityWithLoanAfter',
            'warningText',
        ]
        result = {}
        for name in field_names:
            value = getattr(order_state, name, None)
            if name in numeric_fields and value is not None and value != '':
                if not self._is_reasonable_numeric(value):
                    continue
            if value not in (None, ''):
                result[name] = value
        return result

    def _format_combo_leg_summary(self, leg):
        symbol = leg.local_symbol or leg.symbol or '<unknown>'
        return (
            f"{leg.execution_action} {leg.ratio} x {symbol} "
            f"(comboLegAction={leg.combo_leg_action}, mark={leg.mark}, "
            f"targetPos={leg.target_position})"
        )

    def _log_combo_preview_summary(self, prefix, preview):
        leg_lines = '; '.join(self._format_combo_leg_summary(leg) for leg in preview.legs) if preview.legs else 'no legs'
        self.logger.info(
            f"{prefix} comboSymbol={preview.combo_symbol} exchange={preview.combo_exchange} "
            f"action={preview.order_action} qty={preview.total_quantity} "
            f"limit={preview.limit_price} rawNetMid={preview.raw_net_mid} "
            f"executionMode={preview.execution_mode} pricingSource={preview.pricing_source} "
            f"pricingNote={preview.pricing_note!r} legs=[{leg_lines}]"
        )

    def _log_what_if_summary(self, group_id, what_if):
        if not what_if:
            self.logger.info(f"What-if not available for groupId={group_id}")
            return

        self.logger.info(
            f"What-if for groupId={group_id}: status={what_if.get('status')} "
            f"commission={what_if.get('commission')} {what_if.get('commissionCurrency', '')} "
            f"initMarginChange={what_if.get('initMarginChange')} "
            f"maintMarginChange={what_if.get('maintMarginChange')} "
            f"warningText={what_if.get('warningText')!r}"
        )

    def _normalize_ratio(self, values):
        abs_values = [abs(v) for v in values if abs(v) > 0]
        if not abs_values:
            return 1

        current = abs_values[0]
        for value in abs_values[1:]:
            current = gcd(current, value)

        return current or 1

    def _is_terminal_order_status(self, status):
        return str(status or '').strip() in {'Filled', 'Cancelled', 'ApiCancelled', 'Inactive'}

    def _is_soft_terminal_order_status(self, status):
        return str(status or '').strip() in {'Cancelled', 'ApiCancelled', 'Inactive'}

    def _resolve_order_tracking(self, order_id, perm_id):
        context = None
        if order_id is not None:
            context = self.managed_executions_by_order_id.get(order_id)
        if context is None and perm_id is not None:
            context = self.managed_executions_by_perm_id.get(perm_id)
        if context is not None:
            if order_id is not None:
                self.managed_executions_by_order_id[order_id] = context
            if perm_id is not None:
                self.managed_executions_by_perm_id[perm_id] = context
        return context

    def _build_managed_snapshot(self, context):
        managed_state = context.get('managedState')
        continue_action_label = None
        if managed_state == 'stopped_max_reprices':
            continue_action_label = f'Continue {self.managed_reprice_max_updates} More Retries'
        elif managed_state == 'stopped_timeout':
            continue_minutes = max(int(round(self.managed_reprice_timeout_seconds / 60.0)), 1)
            continue_action_label = f'Continue Monitoring ({continue_minutes} More Minutes)'

        snapshot = {
            'groupId': context.get('groupId'),
            'groupName': context.get('groupName'),
            'executionMode': context.get('executionMode'),
            'executionIntent': context.get('executionIntent'),
            'requestSource': context.get('requestSource'),
            'orderId': context.get('orderId'),
            'permId': context.get('permId'),
            'status': context.get('status'),
            'filled': context.get('filled'),
            'remaining': context.get('remaining'),
            'avgFillPrice': context.get('avgFillPrice'),
            'lastFillPrice': context.get('lastFillPrice'),
            'whyHeld': context.get('whyHeld'),
            'mktCapPrice': context.get('mktCapPrice'),
            'managedMode': True,
            'managedState': context.get('managedState'),
            'workingLimitPrice': context.get('workingLimitPrice'),
            'latestComboMid': context.get('latestComboMid'),
            'bestComboPrice': context.get('bestComboPrice'),
            'worstComboPrice': context.get('worstComboPrice'),
            'managedRepriceThreshold': context.get('managedRepriceThreshold'),
            'managedConcessionRatio': context.get('managedConcessionRatio'),
            'repricingCount': context.get('repricingCount'),
            'maxRepriceCount': context.get('maxRepriceCount'),
            'lastRepriceAt': context.get('lastRepriceAt'),
            'managedMessage': context.get('managedMessage'),
            'canContinueRepricing': managed_state in {'stopped_max_reprices', 'stopped_timeout'},
            'canConcedePricing': managed_state == 'stopped_max_reprices',
            'continueActionLabel': continue_action_label,
        }
        return {key: value for key, value in snapshot.items() if value is not None}

    def _resolve_managed_reprice_threshold(self, request):
        raw = getattr(request, 'managed_reprice_threshold', None)
        try:
            value = round(float(raw), 2)
        except (TypeError, ValueError):
            return self.managed_reprice_threshold

        for allowed in (0.01, 0.02, 0.05):
            if abs(value - allowed) < 0.0001:
                return allowed
        return self.managed_reprice_threshold

    def _resolve_time_in_force(self, request):
        tif = str(getattr(request, 'time_in_force', '') or 'DAY').strip().upper()
        return tif if tif in {'DAY', 'GTC'} else 'DAY'

    def _resolve_managed_concession_ratio(self, raw_value):
        try:
            value = round(float(raw_value), 2)
        except (TypeError, ValueError):
            raise ValueError('Invalid concession ratio.')

        for allowed in (0.10, 0.20, 0.30, 0.50, 0.75, 0.90):
            if abs(value - allowed) < 0.0001:
                return allowed
        raise ValueError('Concession ratio must be one of 0.10, 0.20, 0.30, 0.50, 0.75, or 0.90.')

    async def _emit_managed_update(self, context):
        callback = self.emit_order_update
        websocket = context.get('websocket')
        if websocket is None or callback is None:
            return

        payload = {
            'action': 'combo_order_status_update',
            'groupId': context.get('groupId'),
            'orderStatus': self._build_managed_snapshot(context),
        }

        signature = repr(payload['orderStatus'])
        if signature == context.get('lastManagedEmitSignature'):
            return

        context['lastManagedEmitSignature'] = signature
        try:
            await callback(websocket, payload)
        except Exception:
            self.logger.exception(
                f"Failed to emit managed combo update for groupId={context.get('groupId')}"
            )

    def _build_default_watching_message(self, context):
        threshold = float(context.get('managedRepriceThreshold') or self.managed_reprice_threshold)
        if float(context.get('managedConcessionRatio') or 0.0) > 0:
            return (
                f'Auto-repricing is active with a {int(float(context.get("managedConcessionRatio")) * 100)}% '
                f'concession from middle toward the quoted worst price. '
                f'The backend will refresh the working limit when the target combo price moves by at least {threshold:.2f}.'
            )
        return (
            f'Auto-repricing is active. The backend will refresh the working limit when '
            f'the target combo price moves by at least {threshold:.2f}.'
        )

    def _clear_pending_terminal_confirmation(self, context):
        task = context.get('pendingTerminalTask')
        current_task = asyncio.current_task()
        if task and not task.done() and task is not current_task:
            task.cancel()
        context['pendingTerminalTask'] = None
        context['pendingTerminalStatus'] = None
        context['repricingSuspended'] = False

    async def _finalize_managed_terminal(self, context, terminal_status, message=None):
        self._clear_pending_terminal_confirmation(context)
        if terminal_status == 'Filled':
            context['managedState'] = 'filled'
            context['managedMessage'] = message or 'Order fully filled; auto-repricing is complete.'
        else:
            context['managedState'] = 'done'
            context['managedMessage'] = message or f'Broker order reached terminal status {terminal_status}.'

        await self._emit_managed_update(context)
        if not context.get('terminated'):
            context['terminated'] = True
        task = context.get('task')
        current_task = asyncio.current_task()
        if task and not task.done() and task is not current_task:
            task.cancel()
        self._cleanup_managed_context(context)

    async def _confirm_terminal_status_after_grace(self, context, terminal_status, token):
        try:
            await asyncio.sleep(self.managed_terminal_confirmation_seconds)
        except asyncio.CancelledError:
            return

        if context.get('terminated'):
            return
        if context.get('pendingTerminalToken') != token:
            return

        current_status = str(context.get('status') or '').strip()
        if current_status != terminal_status:
            return

        await self._finalize_managed_terminal(
            context,
            terminal_status,
            f'Broker order remained in terminal status {terminal_status} after modify-state confirmation.',
        )

    def _start_terminal_confirmation(self, context, terminal_status):
        existing_status = str(context.get('pendingTerminalStatus') or '').strip()
        existing_task = context.get('pendingTerminalTask')
        if existing_status == terminal_status and existing_task and not existing_task.done():
            return

        self._clear_pending_terminal_confirmation(context)
        token = int(context.get('pendingTerminalToken') or 0) + 1
        context['pendingTerminalToken'] = token
        context['pendingTerminalStatus'] = terminal_status
        context['repricingSuspended'] = True
        context['managedState'] = 'confirming_terminal'
        context['managedMessage'] = (
            f'Observed broker status {terminal_status}; pausing auto-repricing briefly to confirm '
            f'whether this is a terminal cancel or an in-flight modify/replace.'
        )
        context['pendingTerminalTask'] = asyncio.create_task(
            self._confirm_terminal_status_after_grace(context, terminal_status, token)
        )

    def _compute_quote_bounds_from_resolved_legs(self, resolved_legs):
        direct_net_mid = 0.0
        best_direct = 0.0
        worst_direct = 0.0
        for leg in resolved_legs or []:
            quote = leg.get('quote') or {}
            mark = quote.get('mark')
            bid = quote.get('bid')
            ask = quote.get('ask')
            target_position = int(leg.get('pos') or 0)
            if target_position == 0:
                return None
            if not all(self._is_reasonable_numeric(value) and value > 0 for value in (mark, bid, ask)):
                return None

            target_is_buy = target_position > 0
            sign = 1 if target_is_buy else -1
            favorable_quote = bid if target_is_buy else ask
            unfavorable_quote = ask if target_is_buy else bid
            ratio = int(leg.get('ratio') or 0)

            direct_net_mid += sign * ratio * round(mark, 4)
            best_direct += sign * ratio * round(favorable_quote, 4)
            worst_direct += sign * ratio * round(unfavorable_quote, 4)

        return {
            'rawNetMid': round(direct_net_mid, 4),
            'bestPrice': round(abs(best_direct), 4),
            'worstPrice': round(abs(worst_direct), 4),
        }

    def _resolve_target_limit_from_quote_stats(self, context, latest_abs_mid, best_price, worst_price):
        concession_ratio = float(context.get('managedConcessionRatio') or 0.0)
        worst_price = float(worst_price)
        if concession_ratio <= 0:
            return round(latest_abs_mid, 4)
        return round(latest_abs_mid + concession_ratio * (worst_price - latest_abs_mid), 4)

    async def _compute_live_combo_quote_stats(self, context):
        direct_net_mid = 0.0
        best_direct = 0.0
        worst_direct = 0.0
        for leg in context.get('resolvedLegs', []):
            ticker = self._resolve_existing_order_ticker(context.get('websocket'), leg['request'])
            created_temp_ticker = False
            if ticker is None:
                ticker = await self._request_temporary_ticker(
                    leg['contract'],
                    '106' if self._normalize_symbol(leg['request'].sec_type) in ('OPT', 'FOP') else ''
                )
                created_temp_ticker = True

            try:
                sec_type = self._normalize_symbol(leg['request'].sec_type)
                quote = self._extract_quote_snapshot(ticker, sec_type)
                if quote is None:
                    return None
                leg['quote'] = quote
                target_position = int(leg.get('pos') or 0)
                if target_position == 0:
                    return None
                target_is_buy = target_position > 0
                sign = 1 if target_is_buy else -1
                favorable_quote = quote['bid'] if target_is_buy else quote['ask']
                unfavorable_quote = quote['ask'] if target_is_buy else quote['bid']
                direct_net_mid += sign * leg['ratio'] * quote['mark']
                best_direct += sign * leg['ratio'] * favorable_quote
                worst_direct += sign * leg['ratio'] * unfavorable_quote
            finally:
                if created_temp_ticker:
                    try:
                        self.ib.cancelMktData(leg['contract'])
                    except Exception:
                        pass
        return {
            'rawNetMid': round(direct_net_mid, 4),
            'bestPrice': round(abs(best_direct), 4),
            'worstPrice': round(abs(worst_direct), 4),
        }

    async def _stop_managed_context(self, context, managed_state, message=''):
        context['managedState'] = managed_state
        if message:
            context['managedMessage'] = message
        context['terminated'] = True
        await self._emit_managed_update(context)

    async def _managed_reprice_loop(self, context):
        while not context.get('terminated'):
            await asyncio.sleep(self.managed_reprice_interval_seconds)

            if context.get('terminated'):
                break

            if context.get('repricingSuspended'):
                if context.get('managedState') != 'confirming_terminal':
                    context['managedState'] = 'confirming_terminal'
                    context['managedMessage'] = (
                        'Pausing auto-repricing while confirming the latest broker order status.'
                    )
                await self._emit_managed_update(context)
                continue

            status = str(context.get('status') or '').strip()
            if status == 'Filled':
                await self._finalize_managed_terminal(context, 'Filled')
                break

            filled = float(context.get('filled') or 0)
            remaining = float(context.get('remaining') or 0)
            if filled > 0 and remaining > 0:
                await self._stop_managed_context(
                    context,
                    'stopped_partial_fill',
                    'Auto-repricing paused after a partial fill; remaining order stays working at the last limit.',
                )
                break

            if time.monotonic() >= context.get('timeoutAt', 0):
                await self._stop_managed_context(
                    context,
                    'stopped_timeout',
                    'Auto-repricing window ended. The order is still LIVE in TWS at the last submitted limit and is no longer supervised until you continue monitoring or cancel it.',
                )
                break

            quote_stats = await self._compute_live_combo_quote_stats(context)
            if quote_stats is None:
                context['managedState'] = 'waiting_for_mid'
                context['managedMessage'] = 'Waiting for live bid/ask marks on all combo legs before repricing.'
                await self._emit_managed_update(context)
                continue

            raw_mid = quote_stats['rawNetMid']
            latest_action = 'BUY' if raw_mid >= 0 else 'SELL'
            latest_abs_mid = round(abs(raw_mid), 4)
            context['latestComboMid'] = latest_abs_mid
            context['bestComboPrice'] = quote_stats['bestPrice']
            context['worstComboPrice'] = quote_stats['worstPrice']

            if latest_action != context.get('orderAction'):
                await self._stop_managed_context(
                    context,
                    'stopped_sign_change',
                    'Latest combo mid flipped sign versus the submitted order; auto-repricing stopped for safety.',
                )
                break

            target_limit_source = self._resolve_target_limit_from_quote_stats(
                context,
                latest_abs_mid,
                quote_stats['bestPrice'],
                quote_stats['worstPrice'],
            )
            drift = abs(target_limit_source - float(context.get('workingLimitPrice') or 0))
            threshold = float(context.get('managedRepriceThreshold') or self.managed_reprice_threshold)
            if drift + 1e-9 < threshold:
                context['managedState'] = 'watching'
                context['managedMessage'] = (
                    f'Watching combo pricing drift. Current difference {drift:.4f} is below '
                    f'the {threshold:.2f} repricing threshold.'
                )
                await self._emit_managed_update(context)
                continue

            if int(context.get('repricingCount') or 0) >= int(context.get('maxRepriceCount') or self.managed_reprice_max_updates):
                await self._stop_managed_context(
                    context,
                    'stopped_max_reprices',
                    'Reached the max auto-reprice count. Continue to allow 12 more automatic middle-price retries.',
                )
                break

            new_limit = self._quantize_limit_price(target_limit_source, context.get('orderAction'))
            if abs(new_limit - float(context.get('workingLimitPrice') or 0)) < 1e-9:
                context['managedState'] = 'watching'
                context['managedMessage'] = 'Latest combo target moved, but rounded working limit did not change after tick-size quantization.'
                await self._emit_managed_update(context)
                continue

            try:
                order = context['trade'].order
                order.lmtPrice = new_limit
                order.transmit = True
                context['managedState'] = 'repricing'
                context['managedMessage'] = (
                    f'Repricing working order from {context.get("workingLimitPrice")} to {new_limit} '
                    f'using target combo price {round(target_limit_source, 4)} '
                    f'(mid {latest_abs_mid}, worst {quote_stats["worstPrice"]}).'
                )
                await self._emit_managed_update(context)
                trade = self.ib.placeOrder(context['comboContract'], order)
                context['trade'] = trade
                context['workingLimitPrice'] = new_limit
                context['repricingCount'] = int(context.get('repricingCount') or 0) + 1
                context['lastRepriceAt'] = datetime.utcnow().replace(microsecond=0).isoformat() + 'Z'
                context['managedState'] = 'watching'
                context['managedMessage'] = (
                    f'Updated working limit to {new_limit} from target combo price {round(target_limit_source, 4)}.'
                )
                await self._emit_managed_update(context)
            except Exception as exc:
                await self._stop_managed_context(
                    context,
                    'stopped_modify_failed',
                    f'Auto-repricing failed while updating the live order: {exc}',
                )
                break

    def _register_managed_context(self, websocket, request, combo_contract, trade, preview, resolved_legs):
        if request.execution_mode != 'submit':
            return None

        order = getattr(trade, 'order', None)
        order_status = getattr(trade, 'orderStatus', None)
        if self._is_terminal_order_status(getattr(order_status, 'status', None)):
            return None
        managed_threshold = self._resolve_managed_reprice_threshold(request)
        context = {
            'websocket': websocket,
            'groupId': request.group_id,
            'groupName': request.group_name,
            'executionMode': request.execution_mode,
            'executionIntent': request.execution_intent,
            'requestSource': request.request_source,
            'comboContract': combo_contract,
            'resolvedLegs': resolved_legs,
            'trade': trade,
            'orderAction': preview.order_action,
            'orderId': getattr(order, 'orderId', None),
            'permId': getattr(order_status, 'permId', None),
            'status': getattr(order_status, 'status', None),
            'filled': getattr(order_status, 'filled', None),
            'remaining': getattr(order_status, 'remaining', None),
            'avgFillPrice': getattr(order_status, 'avgFillPrice', None),
            'lastFillPrice': getattr(order_status, 'lastFillPrice', None),
            'whyHeld': getattr(order_status, 'whyHeld', None),
            'mktCapPrice': getattr(order_status, 'mktCapPrice', None),
            'workingLimitPrice': preview.limit_price,
            'latestComboMid': round(abs(preview.raw_net_mid), 4),
            'bestComboPrice': preview.best_combo_price,
            'worstComboPrice': preview.worst_combo_price,
            'managedRepriceThreshold': managed_threshold,
            'managedConcessionRatio': 0.0,
            'repricingCount': 0,
            'maxRepriceCount': self.managed_reprice_max_updates,
            'lastRepriceAt': None,
            'managedState': 'watching',
            'managedMessage': self._build_default_watching_message({
                'managedRepriceThreshold': managed_threshold,
                'managedConcessionRatio': 0.0,
            }),
            'timeoutAt': time.monotonic() + self.managed_reprice_timeout_seconds,
            'terminated': False,
            'lastManagedEmitSignature': None,
            'pendingTerminalStatus': None,
            'pendingTerminalToken': 0,
            'pendingTerminalTask': None,
            'repricingSuspended': False,
        }

        if context['orderId'] is not None:
            self.managed_executions_by_order_id[context['orderId']] = context
        if context['permId'] is not None:
            self.managed_executions_by_perm_id[context['permId']] = context

        context['task'] = asyncio.create_task(self._managed_reprice_loop(context))
        return context

    def _cleanup_managed_context(self, context):
        order_id = context.get('orderId')
        perm_id = context.get('permId')
        if order_id is not None:
            self.managed_executions_by_order_id.pop(order_id, None)
        if perm_id is not None:
            self.managed_executions_by_perm_id.pop(perm_id, None)

    def _on_managed_order_status(self, trade):
        order = getattr(trade, 'order', None)
        order_status = getattr(trade, 'orderStatus', None)
        if order is None or order_status is None:
            return

        order_id = getattr(order, 'orderId', None)
        perm_id = getattr(order_status, 'permId', None)
        context = self._resolve_order_tracking(order_id, perm_id)
        if context is None:
            return

        context['trade'] = trade
        context['orderId'] = order_id
        context['permId'] = perm_id
        context['status'] = getattr(order_status, 'status', None)
        context['filled'] = getattr(order_status, 'filled', None)
        context['remaining'] = getattr(order_status, 'remaining', None)
        context['avgFillPrice'] = getattr(order_status, 'avgFillPrice', None)
        context['lastFillPrice'] = getattr(order_status, 'lastFillPrice', None)
        context['whyHeld'] = getattr(order_status, 'whyHeld', None)
        context['mktCapPrice'] = getattr(order_status, 'mktCapPrice', None)

        if perm_id is not None:
            self.managed_executions_by_perm_id[perm_id] = context

        status = str(context.get('status') or '').strip()
        if status == 'Filled':
            asyncio.create_task(self._finalize_managed_terminal(context, 'Filled'))
            return

        if self._is_soft_terminal_order_status(status):
            if context.get('managedState') == 'cancelling':
                asyncio.create_task(self._finalize_managed_terminal(context, status))
            else:
                self._start_terminal_confirmation(context, status)
                asyncio.create_task(self._emit_managed_update(context))
            return

        if context.get('pendingTerminalStatus'):
            self._clear_pending_terminal_confirmation(context)
            context['managedState'] = 'watching'
            context['managedMessage'] = (
                f'Broker order resumed with status {status}; auto-repricing supervision continues.'
            )

        asyncio.create_task(self._emit_managed_update(context))

    def _should_use_non_guaranteed_routing(self, combo_exchange, combo_legs, order):
        if str(combo_exchange or '').upper() != 'SMART':
            return False
        if len(combo_legs or []) != 2:
            return False
        if str(getattr(order, 'orderType', '') or '').upper() != 'LMT':
            return False
        return True

    def _resolve_limit_pricing(self, request, direct_net_mid, order_action):
        abs_mid = round(abs(direct_net_mid), 4)

        if request.execution_mode != 'test_submit':
            return abs_mid, 'middle', ''

        if order_action == 'BUY':
            test_price = abs_mid * self.test_only_buy_factor
            if abs_mid >= 1.0:
                test_price = min(test_price, abs_mid - 1.0)
            else:
                test_price = min(test_price, max(abs_mid - 0.05, self.test_only_min_debit))
            test_price = max(test_price, self.test_only_min_debit)
            note = 'Test-only guardrail price intentionally set far below the combo mid to avoid fills.'
        else:
            test_price = abs_mid * self.test_only_sell_factor
            if abs_mid >= 1.0:
                test_price = max(test_price, abs_mid + 1.0)
            else:
                test_price = max(test_price, abs_mid + self.test_only_small_credit_buffer)
            note = 'Test-only guardrail price intentionally set far above the combo mid to avoid fills.'

        return round(test_price, 4), 'test_guardrail', note

    def _quantize_limit_price(self, raw_price, order_action):
        increment = Decimal(str(self.default_price_increment))
        price_decimal = Decimal(str(max(float(raw_price), float(self.test_only_min_debit))))
        if order_action == 'BUY':
            quantized = price_decimal.quantize(increment, rounding=ROUND_FLOOR)
        else:
            quantized = price_decimal.quantize(increment, rounding=ROUND_CEILING)

        final_price = max(float(quantized), self.test_only_min_debit)
        return round(final_price, 2)

    async def _build_combo_order_from_request(self, websocket, request):
        if not request.legs:
            raise ValueError('No combo legs were provided.')

        self.logger.info(
            f"Building combo order for groupId={request.group_id} groupName={request.group_name!r} "
            f"executionMode={request.execution_mode} executionIntent={request.execution_intent} "
            f"requestSource={request.request_source} with {len(request.legs)} requested legs"
        )

        resolved_legs = []
        for leg_request in request.legs:
            pos = int(leg_request.pos or 0)
            if pos == 0:
                continue

            qualified_contract, quote = await self._resolve_leg_contract_and_mark(websocket, leg_request)
            resolved_legs.append({
                'request': leg_request,
                'contract': qualified_contract,
                'pos': pos,
                'ratio': abs(pos),
                'quote': quote,
            })

        if not resolved_legs:
            raise ValueError('All combo legs have zero position.')

        quantity = self._normalize_ratio([leg['pos'] for leg in resolved_legs])
        for leg in resolved_legs:
            leg['ratio'] = abs(leg['pos']) // quantity

        direct_net_mid = 0.0
        for leg in resolved_legs:
            direct_net_mid += (1 if leg['pos'] > 0 else -1) * leg['ratio'] * leg['quote']['mark']

        order_action = 'BUY'
        if direct_net_mid < 0:
            order_action = 'SELL'

        combo_exchange = resolved_legs[0]['request'].exchange or getattr(resolved_legs[0]['contract'], 'exchange', '') or 'SMART'
        combo_symbol = request.underlying_symbol or getattr(resolved_legs[0]['contract'], 'symbol', '')
        combo_currency = resolved_legs[0]['request'].currency or getattr(resolved_legs[0]['contract'], 'currency', 'USD') or 'USD'

        combo_contract = Contract(
            secType='BAG',
            symbol=combo_symbol,
            exchange=combo_exchange,
            currency=combo_currency,
        )

        combo_legs = []
        preview_legs = []
        for leg in resolved_legs:
            target_is_buy = leg['pos'] > 0
            combo_leg_action = 'BUY' if target_is_buy else 'SELL'
            if order_action == 'SELL':
                combo_leg_action = 'SELL' if combo_leg_action == 'BUY' else 'BUY'

            combo_leg = ComboLeg(
                conId=leg['contract'].conId,
                ratio=leg['ratio'],
                action=combo_leg_action,
                exchange=getattr(leg['contract'], 'exchange', '') or combo_exchange,
            )
            combo_legs.append(combo_leg)
            leg['comboLegAction'] = combo_leg_action

            preview_legs.append(ComboPreviewLeg(
                id=leg['request'].id,
                symbol=getattr(leg['contract'], 'symbol', ''),
                local_symbol=getattr(leg['contract'], 'localSymbol', ''),
                sec_type=getattr(leg['contract'], 'secType', ''),
                ratio=leg['ratio'],
                mark=leg['quote']['mark'],
                target_position=leg['pos'],
                execution_action='BUY' if leg['pos'] > 0 else 'SELL',
                combo_leg_action=combo_leg_action,
            ))

        combo_contract.comboLegs = combo_legs
        quote_bounds = self._compute_quote_bounds_from_resolved_legs(resolved_legs)

        order = Order()
        order.action = order_action
        order.orderType = 'LMT'
        order.totalQuantity = quantity
        limit_price, pricing_source, pricing_note = self._resolve_limit_pricing(
            request,
            direct_net_mid,
            order_action,
        )
        order.lmtPrice = self._quantize_limit_price(limit_price, order_action)
        order.tif = self._resolve_time_in_force(request)
        order.transmit = True

        if self._should_use_non_guaranteed_routing(combo_exchange, combo_legs, order):
            try:
                order.smartComboRoutingParams = [TagValue('NonGuaranteed', '1')]
                self.logger.info(
                    f"Enabled NonGuaranteed SMART combo routing for groupId={request.group_id} "
                    f"with {len(combo_legs)} legs"
                )
            except Exception:
                pass
        else:
            self.logger.info(
                f"Using default guaranteed combo routing for groupId={request.group_id} "
                f"exchange={combo_exchange} legs={len(combo_legs)} orderType={order.orderType}"
            )

        preview = ComboOrderPreview(
            group_id=request.group_id,
            group_name=request.group_name,
            combo_symbol=combo_symbol,
            combo_exchange=combo_exchange,
            order_action=order_action,
            total_quantity=quantity,
            limit_price=order.lmtPrice,
            pricing_source=pricing_source,
            raw_net_mid=round(direct_net_mid, 4),
            time_in_force=order.tif,
            execution_mode=request.execution_mode or 'preview',
            execution_intent=request.execution_intent or 'open',
            request_source=request.request_source or 'manual',
            pricing_note=pricing_note,
            managed_concession_ratio=0.0,
            best_combo_price=quote_bounds['bestPrice'] if quote_bounds else None,
            worst_combo_price=quote_bounds['worstPrice'] if quote_bounds else None,
            legs=preview_legs,
        )
        return {
            'comboContract': combo_contract,
            'order': order,
            'preview': preview,
            'resolvedLegs': resolved_legs,
        }

    async def validate_combo_order(self, websocket, request):
        if not request.legs:
            raise ValueError('No combo legs were provided.')

        validation_legs = []
        non_zero_legs = 0
        for leg_request in request.legs:
            if int(leg_request.pos or 0) == 0:
                continue
            non_zero_legs += 1
            qualified_contract = await self._validate_leg_contract(leg_request)
            validation_legs.append(ComboValidationLeg(
                id=leg_request.id,
                symbol=getattr(qualified_contract, 'symbol', ''),
                local_symbol=getattr(qualified_contract, 'localSymbol', ''),
                sec_type=getattr(qualified_contract, 'secType', ''),
                con_id=getattr(qualified_contract, 'conId', None),
            ))

        if non_zero_legs == 0:
            raise ValueError('All combo legs have zero position.')

        self.logger.info(
            f"Validation passed for groupId={request.group_id}: "
            f"executionMode={request.execution_mode} legs={len(validation_legs)}"
        )
        return ComboValidationResult(
            group_id=request.group_id,
            group_name=request.group_name,
            execution_mode=request.execution_mode or 'preview',
            valid=True,
            execution_intent=request.execution_intent or 'open',
            request_source=request.request_source or 'manual',
            legs=validation_legs,
        )

    async def preview_combo_order(self, websocket, request):
        build_result = await self._build_combo_order_from_request(websocket, request)
        combo_contract = build_result['comboContract']
        order = build_result['order']
        preview = build_result['preview']
        self._log_combo_preview_summary(
            f"Preview-ready groupId={request.group_id}",
            preview,
        )
        what_if = None
        if hasattr(self.ib, 'whatIfOrderAsync'):
            self.logger.info(
                f"Running IB what-if for groupId={request.group_id} "
                f"orderAction={order.action} qty={order.totalQuantity} limit={order.lmtPrice}"
            )
            try:
                what_if = await asyncio.wait_for(
                    self.ib.whatIfOrderAsync(combo_contract, order),
                    timeout=self.what_if_timeout_seconds,
                )
            except asyncio.TimeoutError:
                self.logger.warning(
                    f"IB what-if timed out for groupId={request.group_id} after "
                    f"{self.what_if_timeout_seconds:.1f}s; returning preview without what-if details"
                )
            except Exception as exc:
                self.logger.warning(
                    f"IB what-if failed for groupId={request.group_id}: {exc}; "
                    f"returning preview without what-if details"
                )
        preview.what_if = self._serialize_what_if(what_if)
        self._log_what_if_summary(request.group_id, preview.what_if)
        return preview

    async def submit_combo_order(self, websocket, request):
        build_result = await self._build_combo_order_from_request(websocket, request)
        combo_contract = build_result['comboContract']
        order = build_result['order']
        preview = build_result['preview']
        resolved_legs = build_result['resolvedLegs']
        self._log_combo_preview_summary(
            f"{'Submitting TEST-ONLY combo' if request.execution_mode == 'test_submit' else 'Submitting combo'} groupId={request.group_id}",
            preview,
        )
        self.logger.info(
            f"Placing combo order for groupId={request.group_id}: "
            f"executionMode={request.execution_mode} action={order.action} qty={order.totalQuantity} "
            f"limit={order.lmtPrice} tif={order.tif}"
        )
        trade = self.ib.placeOrder(combo_contract, order)
        await asyncio.sleep(1.5)
        managed_context = self._register_managed_context(
            websocket,
            request,
            combo_contract,
            trade,
            preview,
            resolved_legs,
        )
        order_status = getattr(trade, 'orderStatus', None)
        trade_log = getattr(trade, 'log', None) or []
        status_message = ''
        if trade_log:
            status_message = getattr(trade_log[-1], 'message', '') or ''
        if managed_context is not None:
            preview.managed_mode = True
            preview.managed_state = managed_context.get('managedState')
            preview.working_limit_price = managed_context.get('workingLimitPrice')
            preview.latest_combo_mid = managed_context.get('latestComboMid')
            preview.best_combo_price = managed_context.get('bestComboPrice')
            preview.worst_combo_price = managed_context.get('worstComboPrice')
            preview.managed_reprice_threshold = managed_context.get('managedRepriceThreshold')
            preview.managed_concession_ratio = managed_context.get('managedConcessionRatio')
            preview.repricing_count = managed_context.get('repricingCount')
            preview.last_reprice_at = managed_context.get('lastRepriceAt')
            preview.managed_message = managed_context.get('managedMessage')
        tracking_legs = [
            {
                'id': leg['request'].id,
                'conId': getattr(leg['contract'], 'conId', None),
                'localSymbol': getattr(leg['contract'], 'localSymbol', ''),
                'symbol': getattr(leg['contract'], 'symbol', ''),
                'secType': getattr(leg['contract'], 'secType', ''),
                'right': getattr(leg['contract'], 'right', ''),
                'strike': getattr(leg['contract'], 'strike', None),
                'expDate': getattr(leg['request'], 'exp_date', ''),
                'targetPosition': leg['pos'],
                'expectedExecutionSide': 'BOT' if leg['pos'] > 0 else 'SLD',
                'ratio': leg['ratio'],
            }
            for leg in resolved_legs
        ]
        result = ComboSubmitResult(
            preview=preview,
            order_id=getattr(getattr(trade, 'order', None), 'orderId', None),
            perm_id=getattr(order_status, 'permId', None),
            status=getattr(order_status, 'status', None),
            status_message=status_message or None,
            tracking_legs=tracking_legs,
        )
        self.logger.info(
            f"Combo order submitted for groupId={request.group_id}: "
            f"executionMode={request.execution_mode} orderId={result.order_id} "
            f"permId={result.perm_id} status={result.status} statusMessage={result.status_message!r}"
        )
        return result

    def get_managed_order_snapshot(self, order_id, perm_id):
        context = self._resolve_order_tracking(order_id, perm_id)
        if context is None:
            return None
        return self._build_managed_snapshot(context)

    def cancel_managed_for_websocket(self, websocket):
        stale_contexts = []
        for context in list(self.managed_executions_by_order_id.values()):
            if context.get('websocket') is websocket and context not in stale_contexts:
                stale_contexts.append(context)

        for context in stale_contexts:
            context['terminated'] = True
            task = context.get('task')
            if task and not task.done():
                task.cancel()
            self._cleanup_managed_context(context)

    async def resume_managed_combo_order(self, websocket, raw_data):
        group_id = raw_data.get('groupId')
        try:
            order_id = int(raw_data.get('orderId')) if raw_data.get('orderId') not in (None, '') else None
        except (TypeError, ValueError):
            order_id = None
        try:
            perm_id = int(raw_data.get('permId')) if raw_data.get('permId') not in (None, '') else None
        except (TypeError, ValueError):
            perm_id = None
        context = self._resolve_order_tracking(order_id, perm_id)
        if context is None:
            raise ValueError('No managed combo order is available to resume.')

        if context.get('websocket') is not websocket:
            raise ValueError('Managed combo order belongs to a different session.')

        status = str(context.get('status') or '').strip()
        if self._is_terminal_order_status(status):
            raise ValueError(f'Cannot resume auto-repricing after terminal broker status {status}.')

        resumable_states = {'stopped_max_reprices', 'stopped_timeout'}
        previous_managed_state = context.get('managedState')
        if previous_managed_state not in resumable_states:
            raise ValueError('This combo order is not waiting for more repricing supervision.')

        context['terminated'] = False
        context['managedState'] = 'watching'
        if previous_managed_state == 'stopped_max_reprices':
            context['maxRepriceCount'] = int(context.get('maxRepriceCount') or self.managed_reprice_max_updates) + self.managed_reprice_max_updates
        context['timeoutAt'] = max(time.monotonic(), context.get('timeoutAt', 0)) + self.managed_reprice_timeout_seconds
        if previous_managed_state == 'stopped_max_reprices':
            context['managedMessage'] = (
                f'Extended auto-repricing budget by {self.managed_reprice_max_updates} more attempts. '
                f'New cap: {context["maxRepriceCount"]}.'
            )
        else:
            context['managedMessage'] = (
                f'Resumed auto-repricing supervision for another {int(self.managed_reprice_timeout_seconds)} seconds '
                f'with drift threshold {float(context.get("managedRepriceThreshold") or self.managed_reprice_threshold):.2f}.'
            )
        task = context.get('task')
        if task and not task.done():
            task.cancel()
        context['task'] = asyncio.create_task(self._managed_reprice_loop(context))
        await self._emit_managed_update(context)
        self.logger.info(
            f"Resumed managed combo repricing for groupId={group_id} "
            f"orderId={context.get('orderId')} permId={context.get('permId')} "
            f"newMaxRepriceCount={context.get('maxRepriceCount')}"
        )
        return self._build_managed_snapshot(context)

    async def concede_managed_combo_order(self, websocket, raw_data):
        group_id = raw_data.get('groupId')
        try:
            order_id = int(raw_data.get('orderId')) if raw_data.get('orderId') not in (None, '') else None
        except (TypeError, ValueError):
            order_id = None
        try:
            perm_id = int(raw_data.get('permId')) if raw_data.get('permId') not in (None, '') else None
        except (TypeError, ValueError):
            perm_id = None

        context = self._resolve_order_tracking(order_id, perm_id)
        if context is None:
            raise ValueError('No managed combo order is available to reprice with concession.')

        if context.get('websocket') is not websocket:
            raise ValueError('Managed combo order belongs to a different session.')

        status = str(context.get('status') or '').strip()
        if self._is_terminal_order_status(status):
            raise ValueError(f'Cannot concede pricing after terminal broker status {status}.')

        concession_ratio = self._resolve_managed_concession_ratio(raw_data.get('concessionRatio'))
        quote_stats = await self._compute_live_combo_quote_stats(context)
        if quote_stats is None:
            raise ValueError('Live bid/ask quotes are not available on all combo legs yet.')

        raw_mid = quote_stats['rawNetMid']
        latest_action = 'BUY' if raw_mid >= 0 else 'SELL'
        latest_abs_mid = round(abs(raw_mid), 4)
        if latest_action != context.get('orderAction'):
            raise ValueError('Latest combo quote flipped sign versus the working order; refusing concession repricing.')

        context['latestComboMid'] = latest_abs_mid
        context['bestComboPrice'] = quote_stats['bestPrice']
        context['worstComboPrice'] = quote_stats['worstPrice']
        context['managedConcessionRatio'] = concession_ratio

        target_limit_source = self._resolve_target_limit_from_quote_stats(
            context,
            latest_abs_mid,
            quote_stats['bestPrice'],
            quote_stats['worstPrice'],
        )
        new_limit = self._quantize_limit_price(target_limit_source, context.get('orderAction'))

        order = getattr(context.get('trade'), 'order', None)
        if order is None:
            raise ValueError('No live broker order is available to modify.')

        previous_limit = float(context.get('workingLimitPrice') or 0)
        task = context.get('task')
        if task and not task.done():
            task.cancel()

        context['terminated'] = False
        context['maxRepriceCount'] = int(context.get('maxRepriceCount') or self.managed_reprice_max_updates) + self.managed_reprice_max_updates
        context['timeoutAt'] = max(time.monotonic(), context.get('timeoutAt', 0)) + self.managed_reprice_timeout_seconds

        if abs(new_limit - previous_limit) >= 1e-9:
            order.lmtPrice = new_limit
            order.transmit = True
            context['managedState'] = 'repricing'
            context['managedMessage'] = (
                f'Conceding {int(concession_ratio * 100)}% toward the quoted worst price. '
                f'Updating working limit from {previous_limit} to {new_limit}.'
            )
            await self._emit_managed_update(context)
            trade = self.ib.placeOrder(context['comboContract'], order)
            context['trade'] = trade
            context['workingLimitPrice'] = new_limit
            context['repricingCount'] = int(context.get('repricingCount') or 0) + 1
            context['lastRepriceAt'] = datetime.utcnow().replace(microsecond=0).isoformat() + 'Z'

        context['managedState'] = 'watching'
        context['managedMessage'] = (
            f'Conceded {int(concession_ratio * 100)}% from middle toward the quoted worst price '
            f'and resumed supervision. New retry cap: {context["maxRepriceCount"]}.'
        )
        context['task'] = asyncio.create_task(self._managed_reprice_loop(context))
        await self._emit_managed_update(context)
        self.logger.info(
            f"Applied managed concession repricing for groupId={group_id} "
            f"orderId={context.get('orderId')} permId={context.get('permId')} "
            f"concessionRatio={concession_ratio:.2f} workingLimit={context.get('workingLimitPrice')}"
        )
        return self._build_managed_snapshot(context)

    async def cancel_managed_combo_order(self, websocket, raw_data):
        group_id = raw_data.get('groupId')
        try:
            order_id = int(raw_data.get('orderId')) if raw_data.get('orderId') not in (None, '') else None
        except (TypeError, ValueError):
            order_id = None
        try:
            perm_id = int(raw_data.get('permId')) if raw_data.get('permId') not in (None, '') else None
        except (TypeError, ValueError):
            perm_id = None

        context = self._resolve_order_tracking(order_id, perm_id)
        if context is None:
            raise ValueError('No managed combo order is available to cancel.')

        if context.get('websocket') is not websocket:
            raise ValueError('Managed combo order belongs to a different session.')

        status = str(context.get('status') or '').strip()
        if self._is_terminal_order_status(status):
            raise ValueError(f'Cannot cancel combo order after terminal broker status {status}.')

        trade = context.get('trade')
        order = getattr(trade, 'order', None) if trade is not None else None
        if order is None:
            raise ValueError('No live broker order is available to cancel.')

        reason = str(raw_data.get('reason') or 'manual_cancel').strip()
        context['terminated'] = True
        context['managedState'] = 'cancelling'
        context['managedMessage'] = (
            'Exit condition hit; cancelling the live combo order in TWS.'
            if reason == 'exit_condition'
            else 'Cancelling the live combo order in TWS.'
        )
        task = context.get('task')
        if task and not task.done():
            task.cancel()

        await self._emit_managed_update(context)
        self.ib.cancelOrder(order)
        self.logger.info(
            f"Requested combo order cancellation for groupId={group_id} "
            f"orderId={context.get('orderId')} permId={context.get('permId')} reason={reason}"
        )
        return self._build_managed_snapshot(context)
