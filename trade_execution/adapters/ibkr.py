import asyncio
import logging
import time
from datetime import datetime
from dataclasses import replace
from math import gcd, isfinite
from decimal import Decimal, ROUND_FLOOR, ROUND_CEILING

from ib_async import ComboLeg, Contract, Order, TagValue

from trade_execution.adapters.base import BrokerExecutionAdapter
from trade_execution.adapters.ibkr_contracts import (
    _build_contract_from_request,
    _describe_contract_request,
    _qualify_one,
    _qualify_underlying_future,
    _request_temporary_ticker,
    _resolve_existing_order_ticker,
    _resolve_family_defaults,
    _resolve_index_exchange_candidates,
    _resolve_leg_contract_and_mark,
    _resolve_weekly_fop_trading_class,
    _to_contract_month,
    _to_expiry,
    _validate_leg_contract,
)
from trade_execution.adapters.ibkr_hedge import (
    _build_hedge_contract_from_request,
    _build_hedge_order,
    _build_hedge_order_from_request,
    _build_hedge_order_snapshot,
    _cleanup_hedge_order_context,
    _on_hedge_order_status,
    _qualify_hedge_contract,
    _register_hedge_order_context,
    _resolve_hedge_order_tracking,
    _validate_hedge_order_request,
    cancel_hedge_order,
    preview_hedge_order,
    submit_hedge_order,
    validate_hedge_order,
)
from trade_execution.models import (
    ComboOrderPreview,
    ComboPreviewLeg,
    ComboSubmitResult,
    ComboValidationLeg,
    ComboValidationResult,
)
from trade_execution.order_tracking import extract_trade_status_message, resolve_tracking


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
        on_combo_order_placed=None,
        portfolio_positions_provider=None,
    ):
        self.ib = ib
        self.client_subscriptions = client_subscriptions
        self.qualified_underlyings = qualified_underlyings
        self.supported_live_families = supported_live_families
        self.index_exchange_fallbacks = index_exchange_fallbacks
        self.logger = logger or logging.getLogger(__name__)
        self.emit_order_update = emit_order_update
        self.on_combo_order_placed = on_combo_order_placed
        self.portfolio_positions_provider = portfolio_positions_provider
        self.what_if_timeout_seconds = 4.0
        self.underlying_close_settle_seconds = 3.0
        self.test_only_buy_factor = 0.2
        self.test_only_sell_factor = 5.0
        self.test_only_small_credit_buffer = 0.5
        self.default_price_increment = 0.01
        self.managed_reprice_threshold = float(managed_reprice_threshold)
        self.managed_reprice_interval_seconds = float(managed_reprice_interval_seconds)
        self.managed_reprice_max_updates = int(managed_reprice_max_updates)
        self.managed_reprice_timeout_seconds = float(managed_reprice_timeout_seconds)
        self.managed_terminal_confirmation_seconds = 3.0
        self.managed_executions_by_order_id = {}
        self.managed_executions_by_perm_id = {}
        self.hedge_orders_by_order_id = {}
        self.hedge_orders_by_perm_id = {}
        self.contract_details_cache_by_con_id = {}
        self.market_rule_cache_by_id = {}
        self.ib.orderStatusEvent += self._on_managed_order_status
        self.ib.orderStatusEvent += self._on_hedge_order_status

    def _resolve_combo_price_increment(self, request=None, context=None):
        profile = {}
        family = ''
        raw_increment = None

        if request is not None:
            profile = getattr(request, 'profile', None) or {}
            family = self._normalize_symbol(profile.get('family') or getattr(request, 'underlying_symbol', ''))
            raw_increment = profile.get('priceIncrement') or profile.get('price_increment')
        elif context is not None:
            profile = context.get('profile') or {}
            family = self._normalize_symbol(
                context.get('family')
                or profile.get('family')
                or context.get('underlyingSymbol')
                or ''
            )
            raw_increment = (
                context.get('priceIncrement')
                or profile.get('priceIncrement')
                or profile.get('price_increment')
            )

        try:
            parsed = float(raw_increment)
            if parsed > 0:
                return parsed
        except (TypeError, ValueError):
            pass

        if family == 'HG':
            return 0.0005

        defaults = self._resolve_family_defaults(family) if family else None
        if defaults:
            try:
                parsed = float(defaults.get('price_increment') or defaults.get('priceIncrement'))
                if parsed > 0:
                    return parsed
            except (TypeError, ValueError):
                pass

        return float(self.default_price_increment)

    def _get_valid_managed_reprice_thresholds(self):
        return (0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05)

    def _format_managed_reprice_threshold(self, value):
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            parsed = float(self.managed_reprice_threshold)
        raw = f'{parsed:.2f}' if parsed >= 0.01 else f'{parsed:.4f}'
        return raw.rstrip('0').rstrip('.')

    def _is_reasonable_numeric(self, value):
        return isinstance(value, (int, float)) and isfinite(value) and abs(value) < 1e100

    def _extract_trade_status_message(self, trade):
        return extract_trade_status_message(trade)

    def _get_partial_fill_progress(self, context):
        try:
            filled = float(context.get('filled') or 0)
            remaining = float(context.get('remaining') or 0)
        except (TypeError, ValueError):
            return None

        if filled > 0 and remaining > 0:
            return filled, remaining
        return None

    def _build_partial_fill_message_prefix(self, context):
        progress = self._get_partial_fill_progress(context)
        if progress is None:
            return ''

        filled, remaining = progress
        return (
            f'Partially filled ({filled:g} filled, {remaining:g} remaining); '
            f'continuing to supervise and reprice the remaining order. '
        )

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

    def _normalize_exchange(self, value):
        return str(value or '').strip().upper()

    def _safe_positive_float(self, value):
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return None
        return parsed if parsed > 0 and parsed == parsed else None

    def _select_market_rule_id(self, contract_details, exchange):
        raw_rule_ids = str(getattr(contract_details, 'marketRuleIds', '') or '').strip()
        if not raw_rule_ids:
            return None

        rule_ids = [item.strip() for item in raw_rule_ids.split(',')]
        if not rule_ids:
            return None

        valid_exchanges = [
            self._normalize_exchange(item)
            for item in str(getattr(contract_details, 'validExchanges', '') or '').split(',')
        ]
        requested_exchange = self._normalize_exchange(exchange)
        for index, valid_exchange in enumerate(valid_exchanges):
            if requested_exchange and valid_exchange == requested_exchange and index < len(rule_ids):
                return rule_ids[index]

        primary_exchange = self._normalize_exchange(getattr(contract_details, 'contract', None) and getattr(contract_details.contract, 'exchange', ''))
        for index, valid_exchange in enumerate(valid_exchanges):
            if primary_exchange and valid_exchange == primary_exchange and index < len(rule_ids):
                return rule_ids[index]

        return rule_ids[0]

    async def _get_contract_details_for_contract(self, contract):
        con_id = getattr(contract, 'conId', None)
        if con_id not in (None, ''):
            try:
                cache_key = int(con_id)
            except (TypeError, ValueError):
                cache_key = str(con_id).strip()
            if cache_key in self.contract_details_cache_by_con_id:
                return self.contract_details_cache_by_con_id[cache_key]

        if not hasattr(self.ib, 'reqContractDetailsAsync'):
            return None

        try:
            details = await self.ib.reqContractDetailsAsync(contract)
        except Exception as exc:
            self.logger.warning(
                f"Failed to request contract details for conId={con_id}: {exc}"
            )
            return None

        contract_details = details[0] if details else None
        if contract_details is not None and con_id not in (None, ''):
            self.contract_details_cache_by_con_id[cache_key] = contract_details
        return contract_details

    async def _get_market_rule_increments(self, market_rule_id):
        try:
            rule_key = int(market_rule_id)
        except (TypeError, ValueError):
            return []
        if rule_key in self.market_rule_cache_by_id:
            return self.market_rule_cache_by_id[rule_key]
        if not hasattr(self.ib, 'reqMarketRuleAsync'):
            return []

        try:
            increments = await self.ib.reqMarketRuleAsync(rule_key)
        except Exception as exc:
            self.logger.warning(f"Failed to request IB market rule {rule_key}: {exc}")
            return []

        cleaned = []
        for increment in increments or []:
            low_edge = self._safe_positive_float(getattr(increment, 'lowEdge', None))
            if low_edge is None:
                try:
                    low_edge = float(getattr(increment, 'lowEdge', 0) or 0)
                except (TypeError, ValueError):
                    low_edge = 0.0
            price_increment = self._safe_positive_float(getattr(increment, 'increment', None))
            if price_increment is None:
                continue
            cleaned.append((float(low_edge), float(price_increment)))
        cleaned.sort(key=lambda item: item[0])
        self.market_rule_cache_by_id[rule_key] = cleaned
        return cleaned

    def _select_increment_from_ladder(self, price, increments):
        price_abs = abs(float(price or 0))
        selected = None
        for low_edge, increment in increments or []:
            if price_abs + 1e-12 >= float(low_edge):
                selected = float(increment)
            else:
                break
        return selected

    async def _resolve_contract_price_increment(self, contract, exchange, reference_price, fallback_increment=None):
        fallback = self._safe_positive_float(fallback_increment) or float(self.default_price_increment)
        details = await self._get_contract_details_for_contract(contract)
        if details is None:
            return fallback

        market_rule_id = self._select_market_rule_id(details, exchange)
        increments = await self._get_market_rule_increments(market_rule_id)
        selected = self._select_increment_from_ladder(reference_price, increments)
        if selected:
            return selected

        min_tick = self._safe_positive_float(getattr(details, 'minTick', None))
        return min_tick or fallback

    async def _resolve_price_increment_for_legs(self, resolved_legs, raw_limit_price, combo_exchange, fallback_increment):
        fallback = self._safe_positive_float(fallback_increment) or float(self.default_price_increment)
        legs = list(resolved_legs or [])
        if not legs:
            return fallback

        if len(legs) == 1:
            leg = legs[0]
            exchange = (
                getattr(leg.get('contract'), 'exchange', '')
                or getattr(leg.get('request'), 'exchange', '')
                or combo_exchange
            )
            return await self._resolve_contract_price_increment(
                leg.get('contract'),
                exchange,
                raw_limit_price,
                fallback,
            )

        increments = []
        for leg in legs:
            leg_reference = (leg.get('quote') or {}).get('mark') or raw_limit_price
            exchange = (
                getattr(leg.get('contract'), 'exchange', '')
                or getattr(leg.get('request'), 'exchange', '')
                or combo_exchange
            )
            increment = await self._resolve_contract_price_increment(
                leg.get('contract'),
                exchange,
                leg_reference,
                fallback,
            )
            if increment:
                increments.append(float(increment))

        if increments:
            return min(increments)
        return fallback

    async def _resolve_order_price_increment(self, request, resolved_legs, order_action, raw_limit_price, combo_exchange):
        return await self._resolve_price_increment_for_legs(
            resolved_legs,
            raw_limit_price,
            combo_exchange,
            self._resolve_combo_price_increment(request=request),
        )

    async def _resolve_context_price_increment(self, context, raw_limit_price):
        combo_contract = context.get('comboContract')
        return await self._resolve_price_increment_for_legs(
            context.get('resolvedLegs') or [],
            raw_limit_price,
            getattr(combo_contract, 'exchange', '') or '',
            self._resolve_combo_price_increment(context=context),
        )

    def _format_price_increment(self, value):
        parsed = self._safe_positive_float(value)
        if parsed is None:
            return ''
        text = format(Decimal(str(parsed)).normalize(), 'f')
        return text.rstrip('0').rstrip('.') or '0'

    def _coarser_price_increment_candidates(self, current_increment, max_candidates=4):
        current = Decimal(str(
            self._safe_positive_float(current_increment) or self.default_price_increment
        ))
        preferred_ladders = {
            Decimal('0.0001'): (Decimal('0.0005'), Decimal('0.001'), Decimal('0.005'), Decimal('0.01')),
            Decimal('0.0005'): (Decimal('0.001'), Decimal('0.005'), Decimal('0.01'), Decimal('0.05')),
            Decimal('0.001'): (Decimal('0.005'), Decimal('0.01'), Decimal('0.05'), Decimal('0.25')),
            Decimal('0.005'): (Decimal('0.01'), Decimal('0.05'), Decimal('0.25'), Decimal('0.5')),
            Decimal('0.01'): (Decimal('0.05'), Decimal('0.25'), Decimal('0.5'), Decimal('1')),
            Decimal('0.05'): (Decimal('0.25'), Decimal('0.5'), Decimal('1'), Decimal('2.5')),
            Decimal('0.25'): (Decimal('0.5'), Decimal('1'), Decimal('2.5'), Decimal('5')),
            Decimal('0.5'): (Decimal('1'), Decimal('2.5'), Decimal('5')),
            Decimal('1'): (Decimal('2.5'), Decimal('5'), Decimal('10')),
        }
        common_increments = (
            Decimal('0.0005'),
            Decimal('0.001'),
            Decimal('0.005'),
            Decimal('0.01'),
            Decimal('0.05'),
            Decimal('0.25'),
            Decimal('0.5'),
            Decimal('1'),
            Decimal('2.5'),
            Decimal('5'),
            Decimal('10'),
        )
        candidates = []
        seen = set()

        def add_candidate(candidate):
            candidate = Decimal(str(candidate))
            if candidate <= current:
                return
            key = str(candidate.normalize())
            if key in seen:
                return
            seen.add(key)
            candidates.append(float(candidate))

        preferred_candidates = preferred_ladders.get(current)
        if preferred_candidates:
            for candidate in preferred_candidates:
                add_candidate(candidate)
            for multiplier in (Decimal('2'), Decimal('5'), Decimal('10')):
                add_candidate(current * multiplier)
        else:
            for candidate in common_increments:
                add_candidate(candidate)
            for multiplier in (Decimal('2'), Decimal('5'), Decimal('10')):
                add_candidate(current * multiplier)
        return candidates[:max(0, int(max_candidates or 0))]

    def _is_min_price_variation_reject(self, status, status_message):
        text = str(status_message or '').strip().lower()
        if not text:
            return False
        return (
            'minimum price variation' in text
            or 'does not conform to the minimum price variation' in text
            or 'error 110' in text
            or 'ib 110' in text
        )

    def _clone_order_for_limit_retry(self, order, limit_price):
        retry_order = Order()
        skip_attrs = {'orderId', 'permId', 'clientId'}
        try:
            order_items = vars(order).items()
        except TypeError:
            order_items = []
        for attr, value in order_items:
            if attr in skip_attrs:
                continue
            if attr == 'smartComboRoutingParams' and isinstance(value, list):
                value = list(value)
            setattr(retry_order, attr, value)

        for attr in (
            'action',
            'orderType',
            'totalQuantity',
            'tif',
            'account',
            'smartComboRoutingParams',
            'outsideRth',
            'orderRef',
            'usePriceMgmtAlgo',
        ):
            if attr in skip_attrs or hasattr(retry_order, attr) or not hasattr(order, attr):
                continue
            value = getattr(order, attr)
            if attr == 'smartComboRoutingParams' and isinstance(value, list):
                value = list(value)
            setattr(retry_order, attr, value)

        retry_order.lmtPrice = limit_price
        retry_order.transmit = True
        return retry_order

    _to_contract_month = _to_contract_month
    _to_expiry = _to_expiry
    _resolve_family_defaults = _resolve_family_defaults
    _resolve_index_exchange_candidates = _resolve_index_exchange_candidates
    _resolve_weekly_fop_trading_class = _resolve_weekly_fop_trading_class
    _qualify_underlying_future = _qualify_underlying_future
    _build_contract_from_request = _build_contract_from_request
    _build_hedge_contract_from_request = _build_hedge_contract_from_request
    _validate_hedge_order_request = _validate_hedge_order_request
    _qualify_hedge_contract = _qualify_hedge_contract
    _build_hedge_order = _build_hedge_order
    _build_hedge_order_from_request = _build_hedge_order_from_request
    _register_hedge_order_context = _register_hedge_order_context
    _on_hedge_order_status = _on_hedge_order_status
    _describe_contract_request = _describe_contract_request
    _qualify_one = _qualify_one
    _request_temporary_ticker = _request_temporary_ticker
    _resolve_existing_order_ticker = _resolve_existing_order_ticker
    _resolve_leg_contract_and_mark = _resolve_leg_contract_and_mark
    _validate_leg_contract = _validate_leg_contract

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
            f"executionMode={preview.execution_mode} account={preview.account or ''} pricingSource={preview.pricing_source} "
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
        return str(status or '').strip() in {'Filled', 'Cancelled', 'ApiCancelled', 'Inactive', 'Rejected'}

    def _is_soft_terminal_order_status(self, status):
        return str(status or '').strip() in {'Cancelled', 'ApiCancelled', 'Inactive', 'Rejected'}

    def _resolve_order_tracking(self, order_id, perm_id):
        return resolve_tracking(
            self.managed_executions_by_order_id,
            self.managed_executions_by_perm_id,
            order_id,
            perm_id,
        )

    _resolve_hedge_order_tracking = _resolve_hedge_order_tracking
    _cleanup_hedge_order_context = _cleanup_hedge_order_context
    _build_hedge_order_snapshot = _build_hedge_order_snapshot

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
            'account': context.get('account'),
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
            'canConcedePricing': managed_state in {'stopped_max_reprices', 'watching', 'repricing'},
            'continueActionLabel': continue_action_label,
        }
        return {key: value for key, value in snapshot.items() if value is not None}

    def _resolve_managed_reprice_threshold(self, request):
        raw = getattr(request, 'managed_reprice_threshold', None)
        try:
            value = round(float(raw), 4)
        except (TypeError, ValueError):
            return self.managed_reprice_threshold

        for allowed in self._get_valid_managed_reprice_thresholds():
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
        partial_fill_prefix = self._build_partial_fill_message_prefix(context)
        if float(context.get('managedConcessionRatio') or 0.0) > 0:
            return (
                partial_fill_prefix +
                f'Auto-repricing is active with a {int(float(context.get("managedConcessionRatio")) * 100)}% '
                f'concession from middle toward the quoted worst price. '
                f'The backend will refresh the working limit when the target combo price moves by at least '
                f'{self._format_managed_reprice_threshold(threshold)}.'
            )
        return (
            partial_fill_prefix +
            f'Auto-repricing is active. The backend will refresh the working limit when '
            f'the target combo price moves by at least {self._format_managed_reprice_threshold(threshold)}.'
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
                    f'{self._build_partial_fill_message_prefix(context)}'
                    f'Watching combo pricing drift. Current difference {drift:.4f} is below '
                    f'the {self._format_managed_reprice_threshold(threshold)} repricing threshold.'
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

            price_increment = await self._resolve_context_price_increment(
                context,
                target_limit_source,
            )
            context['priceIncrement'] = price_increment
            new_limit = self._quantize_limit_price(
                target_limit_source,
                context.get('orderAction'),
                price_increment,
            )
            if abs(new_limit - float(context.get('workingLimitPrice') or 0)) < 1e-9:
                context['managedState'] = 'watching'
                context['managedMessage'] = (
                    f'{self._build_partial_fill_message_prefix(context)}'
                    'Latest combo target moved, but rounded working limit did not change after tick-size quantization.'
                )
                await self._emit_managed_update(context)
                continue

            try:
                order = context['trade'].order
                order.lmtPrice = new_limit
                order.transmit = True
                context['managedState'] = 'repricing'
                context['managedMessage'] = (
                    f'{self._build_partial_fill_message_prefix(context)}'
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
                    f'{self._build_partial_fill_message_prefix(context)}'
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
            'underlyingSymbol': request.underlying_symbol,
            'family': self._normalize_symbol((request.profile or {}).get('family') or request.underlying_symbol),
            'profile': dict(request.profile or {}),
            'priceIncrement': self._safe_positive_float(getattr(preview, 'price_increment', None))
                or self._resolve_combo_price_increment(request=request),
            'executionMode': request.execution_mode,
            'account': str(getattr(order, 'account', '') or request.account or '').strip() or None,
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
            'managedConcessionRatio': float(request.managed_concession_ratio or 0.0),
            'repricingCount': 0,
            'maxRepriceCount': self.managed_reprice_max_updates,
            'lastRepriceAt': None,
            'managedState': 'watching',
            'managedMessage': self._build_default_watching_message({
                'managedRepriceThreshold': managed_threshold,
                'managedConcessionRatio': float(request.managed_concession_ratio or 0.0),
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
        context['account'] = str(getattr(order, 'account', '') or context.get('account') or '').strip() or None
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
        elif self._get_partial_fill_progress(context) is not None and context.get('managedState') in {'watching', 'repricing', 'waiting_for_mid'}:
            context['managedState'] = 'watching'
            context['managedMessage'] = (
                f'{self._build_partial_fill_message_prefix(context)}'
                'Awaiting the next pricing check for the remaining order.'
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

    def _is_assignment_aware_close_request(self, request):
        return (
            self._normalize_symbol(getattr(request, 'execution_mode', '')) in {'PREVIEW', 'SUBMIT', 'TEST_SUBMIT'}
            and self._normalize_symbol(getattr(request, 'execution_intent', '')) == 'CLOSE'
            and str(getattr(request, 'request_source', '') or '').strip() == 'close_group'
            and callable(self.portfolio_positions_provider)
        )

    def _get_portfolio_position_items(self):
        if not callable(self.portfolio_positions_provider):
            return []
        try:
            items = self.portfolio_positions_provider()
        except Exception:
            self.logger.exception('Failed to read TWS portfolio positions for assignment-aware close.')
            return []
        return [item for item in (items or []) if isinstance(item, dict)]

    def _portfolio_item_matches_account(self, item, account):
        requested_account = str(account or '').strip()
        if not requested_account:
            return True
        return str(item.get('account') or '').strip() == requested_account

    def _portfolio_item_position(self, item):
        try:
            position = float(item.get('position') or 0)
        except (TypeError, ValueError):
            return 0.0
        return position if abs(position) > 0.000001 else 0.0

    def _portfolio_has_symbol_snapshot(self, request, items):
        requested_account = str(getattr(request, 'account', '') or '').strip()
        requested_symbols = set()
        profile = getattr(request, 'profile', None) or {}
        for symbol in (
            getattr(request, 'underlying_symbol', ''),
            profile.get('underlyingSymbol'),
            profile.get('optionSymbol'),
        ):
            normalized = self._normalize_symbol(symbol)
            if normalized:
                requested_symbols.add(normalized)
        for leg_request in getattr(request, 'legs', None) or []:
            for symbol in (leg_request.symbol, leg_request.underlying_symbol):
                normalized = self._normalize_symbol(symbol)
                if normalized:
                    requested_symbols.add(normalized)

        if not requested_symbols:
            return bool(items)

        for item in items:
            if not self._portfolio_item_matches_account(item, requested_account):
                continue
            if self._normalize_symbol(item.get('symbol')) in requested_symbols:
                return True
        return False

    def _find_portfolio_item_for_leg(self, leg_request, request, items):
        sec_type = self._normalize_symbol(leg_request.sec_type)
        symbol = self._normalize_symbol(leg_request.symbol)
        account = str(getattr(request, 'account', '') or '').strip()
        exp_date = self._to_expiry(leg_request.exp_date)
        right = self._normalize_symbol(leg_request.right)
        strike = leg_request.strike

        for item in items:
            if not self._portfolio_item_matches_account(item, account):
                continue
            if self._normalize_symbol(item.get('secType')) != sec_type:
                continue
            if self._normalize_symbol(item.get('symbol')) != symbol:
                continue

            if sec_type in {'STK', 'IND'}:
                return item

            if sec_type == 'FUT':
                contract_month = self._to_contract_month(leg_request.contract_month)
                item_month = self._to_contract_month(item.get('expDate'))
                if contract_month and item_month and contract_month != item_month:
                    continue
                return item

            if sec_type in {'OPT', 'FOP'}:
                if self._to_expiry(item.get('expDate')) != exp_date:
                    continue
                if self._normalize_symbol(item.get('right')) != right:
                    continue
                try:
                    item_strike = float(item.get('strike'))
                    request_strike = float(strike)
                except (TypeError, ValueError):
                    continue
                if abs(item_strike - request_strike) > 0.0001:
                    continue
                return item
        return None

    def _clamp_close_position_to_actual(self, close_position, actual_position):
        try:
            close_position = int(close_position or 0)
            actual_position = float(actual_position or 0)
        except (TypeError, ValueError):
            return 0
        if close_position == 0 or abs(actual_position) < 0.000001:
            return 0
        if (close_position > 0 and actual_position > 0) or (close_position < 0 and actual_position < 0):
            return 0
        close_quantity = min(abs(close_position), int(abs(actual_position)))
        return close_quantity if close_position > 0 else -close_quantity

    def _settlement_units_for_option_leg(self, leg_request):
        sec_type = self._normalize_symbol(leg_request.sec_type)
        if sec_type == 'FOP':
            return 1
        try:
            multiplier = int(float(leg_request.multiplier or leg_request.underlying_multiplier or 100))
        except (TypeError, ValueError):
            multiplier = 100
        return max(multiplier, 1)

    def _assignment_underlying_position(self, leg_request, assigned_option_position):
        units = self._settlement_units_for_option_leg(leg_request)
        right = self._normalize_symbol(leg_request.right)
        if right == 'C':
            return int(assigned_option_position * units)
        if right == 'P':
            return int(-assigned_option_position * units)
        return 0

    def _build_underlying_leg_from_option_assignment(self, leg_request, close_position):
        sec_type = 'FUT' if self._normalize_symbol(leg_request.sec_type) == 'FOP' else 'STK'
        symbol = (
            leg_request.underlying_symbol
            or (self._resolve_family_defaults(leg_request.symbol) or {}).get('underlying_symbol')
            or leg_request.symbol
        )
        exchange = leg_request.underlying_exchange or leg_request.exchange or 'SMART'
        multiplier = leg_request.underlying_multiplier if sec_type == 'FUT' else ''
        contract_month = leg_request.underlying_contract_month if sec_type == 'FUT' else ''
        return replace(
            leg_request,
            id=f"__assigned_underlying_{leg_request.id or 'leg'}",
            type='stock',
            pos=int(close_position),
            sec_type=sec_type,
            symbol=symbol,
            underlying_symbol=symbol,
            exchange=exchange,
            underlying_exchange=exchange,
            multiplier=str(multiplier or ''),
            underlying_multiplier=str(multiplier or ''),
            trading_class=None,
            right='',
            strike=None,
            exp_date='',
            contract_month=contract_month,
            underlying_contract_month=contract_month,
        )

    def _contract_number_key(self, value):
        if value in (None, ''):
            return ''
        try:
            number = float(value)
        except (TypeError, ValueError):
            return str(value or '').strip()
        if number.is_integer():
            return str(int(number))
        return f"{number:g}"

    def _portfolio_item_contract_key(self, item):
        account = str(item.get('account') or '').strip()
        con_id = item.get('conId')
        if con_id not in (None, ''):
            try:
                normalized_con_id = int(con_id)
            except (TypeError, ValueError):
                normalized_con_id = str(con_id).strip()
            return ('conId', account, normalized_con_id)

        sec_type = self._normalize_symbol(item.get('secType'))
        symbol = self._normalize_symbol(item.get('symbol'))
        multiplier = self._contract_number_key(item.get('multiplier'))
        if sec_type in {'OPT', 'FOP'}:
            return (
                'contract',
                account,
                sec_type,
                symbol,
                self._to_expiry(item.get('expDate')),
                self._normalize_symbol(item.get('right')),
                self._contract_number_key(item.get('strike')),
                multiplier,
            )
        if sec_type == 'FUT':
            return (
                'contract',
                account,
                sec_type,
                symbol,
                self._to_contract_month(item.get('expDate')),
                multiplier,
            )
        return ('contract', account, sec_type, symbol)

    def _portfolio_item_label(self, item):
        sec_type = self._normalize_symbol(item.get('secType'))
        symbol = self._normalize_symbol(item.get('symbol'))
        if sec_type in {'OPT', 'FOP'}:
            return (
                f"{sec_type} {symbol} {self._to_expiry(item.get('expDate'))} "
                f"{self._normalize_symbol(item.get('right'))}{self._contract_number_key(item.get('strike'))}"
            ).strip()
        if sec_type == 'FUT':
            return f"{sec_type} {symbol} {self._to_contract_month(item.get('expDate'))}".strip()
        return f"{sec_type} {symbol}".strip()

    def _reset_assignment_underlying_allocation(self, source):
        if (source or {}).get('kind') != 'assignment':
            return
        adjustment = source.get('adjustment') or {}
        adjustment['underlyingClosePosition'] = 0
        adjustment['underlyingQuantity'] = 0

    def _add_underlying_close_demand(self, aggregate, request, portfolio_items, leg_request, source, messages):
        item = self._find_portfolio_item_for_leg(leg_request, request, portfolio_items)
        if item is None:
            messages.append(
                f"Skipped underlying close demand for {leg_request.id or leg_request.symbol}: "
                f"no matching TWS portfolio position was found."
            )
            self._reset_assignment_underlying_allocation(source)
            return

        key = self._portfolio_item_contract_key(item)
        bucket = aggregate.setdefault(key, {
            'item': item,
            'demands': [],
        })
        bucket['demands'].append({
            'leg': replace(leg_request),
            'requestedClosePosition': int(leg_request.pos or 0),
            'source': source,
        })

    def _append_assignment_close_plan_warnings(self, messages, assignment_adjustments, underlying_legs):
        if any('account-level TWS portfolio positions' in str(message) for message in messages):
            return
        messages.insert(
            0,
            'Close Group uses account-level TWS portfolio positions; '
            'it cannot distinguish other groups or manual positions that share the same contract.'
        )
        messages.insert(
            1,
            'Using the latest cached TWS portfolio snapshot. Refresh/sync TWS before closing if positions changed.'
        )
        if underlying_legs and not any('legged workflow' in str(message) for message in messages):
            messages.insert(
                2,
                'Underlying-first Close is a legged workflow; remaining option legs are submitted only after '
                'the underlying stage fills, which can briefly change hedge exposure.'
            )

    def _allocate_underlying_close_demands(self, aggregate, messages):
        underlying_legs = []
        for bucket in aggregate.values():
            item = bucket.get('item') or {}
            demands = list(bucket.get('demands') or [])
            requested_total = sum(int(demand.get('requestedClosePosition') or 0) for demand in demands)
            actual_position = self._portfolio_item_position(item)
            closeable_total = self._clamp_close_position_to_actual(
                requested_total,
                actual_position,
            )
            item_label = self._portfolio_item_label(item)
            if not closeable_total:
                messages.append(
                    f"Skipped inferred underlying close for {item_label}: "
                    f"TWS position {actual_position:g} does not match requested close direction {requested_total:g}."
                )
                for demand in demands:
                    self._reset_assignment_underlying_allocation(demand.get('source'))
                continue

            if abs(closeable_total) < abs(requested_total):
                messages.append(
                    f"Only {abs(closeable_total):g} of {abs(requested_total):g} requested "
                    f"{item_label} underlying unit(s) are available in TWS; closing the available amount."
                )

            remaining = abs(int(closeable_total))
            direction = 1 if closeable_total > 0 else -1
            for demand in demands:
                requested_position = int(demand.get('requestedClosePosition') or 0)
                source = demand.get('source') or {}
                allocated_position = 0
                if requested_position * direction > 0 and remaining > 0:
                    allocated_quantity = min(abs(requested_position), remaining)
                    allocated_position = direction * allocated_quantity
                    remaining -= allocated_quantity

                if not allocated_position:
                    self._reset_assignment_underlying_allocation(source)
                    continue

                leg = replace(demand['leg'], pos=allocated_position)
                if source.get('kind') == 'assignment':
                    adjustment = source.get('adjustment') or {}
                    adjustment['underlyingLegId'] = leg.id
                    adjustment['underlyingClosePosition'] = allocated_position
                    adjustment['underlyingQuantity'] = -allocated_position
                underlying_legs.append(leg)

        return underlying_legs

    def _build_assignment_aware_close_plan(self, request):
        if not self._is_assignment_aware_close_request(request):
            return {
                'optionRequest': request,
                'underlyingLegs': [],
                'assignmentAdjustments': [],
                'messages': [],
            }

        portfolio_items = self._get_portfolio_position_items()
        if not self._portfolio_has_symbol_snapshot(request, portfolio_items):
            raise ValueError(
                'TWS portfolio positions are not ready for assignment-aware Close. '
                'Refresh/sync the TWS portfolio snapshot, then try Close Group again.'
            )

        option_legs = []
        underlying_aggregate = {}
        assignment_adjustments = []
        messages = []

        for leg_request in request.legs:
            requested_close_position = int(leg_request.pos or 0)
            if requested_close_position == 0:
                continue

            sec_type = self._normalize_symbol(leg_request.sec_type)
            item = self._find_portfolio_item_for_leg(leg_request, request, portfolio_items)
            actual_position = self._portfolio_item_position(item) if item else 0.0
            closeable_position = self._clamp_close_position_to_actual(
                requested_close_position,
                actual_position,
            )

            if sec_type in {'OPT', 'FOP'}:
                if closeable_position:
                    option_legs.append(replace(leg_request, pos=closeable_position))

                missing_quantity = abs(requested_close_position) - abs(closeable_position)
                if missing_quantity <= 0:
                    continue

                assigned_option_position = (-1 if requested_close_position > 0 else 1) * missing_quantity
                underlying_position = self._assignment_underlying_position(
                    leg_request,
                    assigned_option_position,
                )
                underlying_close_position = -underlying_position
                if underlying_close_position == 0:
                    raise ValueError(
                        f"Cannot infer assignment/exercise deliverable for "
                        f"{leg_request.id or self._describe_contract_request(leg_request)}: "
                        f"unsupported option right {leg_request.right!r}."
                    )

                underlying_leg = self._build_underlying_leg_from_option_assignment(
                    leg_request,
                    underlying_close_position,
                )
                adjustment = {
                    'adjustmentId': f"{leg_request.id or 'leg'}:{assigned_option_position}",
                    'optionLegId': leg_request.id,
                    'assignedOptionPosition': assigned_option_position,
                    'remainingOptionPosition': -closeable_position if closeable_position else 0,
                    'underlyingLegId': underlying_leg.id,
                    'underlyingSecType': underlying_leg.sec_type,
                    'underlyingSymbol': underlying_leg.symbol,
                    # Deliverable produced by the assignment/exercise (cost basis = strike). Invariant:
                    # it is never cleared by allocation, so the client can always book the conversion
                    # even when the close order nets to zero against an existing TWS position.
                    'deliverableUnderlyingPosition': underlying_position,
                    'underlyingQuantity': underlying_position,
                    'underlyingClosePosition': underlying_close_position,
                    'assignmentStrike': leg_request.strike,
                    'assignmentRight': leg_request.right,
                    'source': 'tws_assignment_close_plan',
                }
                assignment_adjustments.append(adjustment)
                self._add_underlying_close_demand(
                    underlying_aggregate,
                    request,
                    portfolio_items,
                    underlying_leg,
                    {
                        'kind': 'assignment',
                        'adjustment': adjustment,
                    },
                    messages,
                )
                messages.append(
                    f"Detected assignment/exercise on {leg_request.id or self._describe_contract_request(leg_request)}: "
                    f"{missing_quantity} contract(s) no longer exist in TWS; "
                    f"will close {abs(underlying_close_position)} underlying unit(s) first."
                )
                continue

            if sec_type in {'STK', 'FUT'}:
                if not closeable_position:
                    messages.append(
                        f"Skipped underlying close leg {leg_request.id or leg_request.symbol}: "
                        f"TWS position does not match requested close direction."
                    )
                    continue
                self._add_underlying_close_demand(
                    underlying_aggregate,
                    request,
                    portfolio_items,
                    leg_request,
                    {
                        'kind': 'existing_underlying',
                        'legId': leg_request.id,
                    },
                    messages,
                )
                continue

            option_legs.append(leg_request)

        underlying_legs = self._allocate_underlying_close_demands(underlying_aggregate, messages)
        self._append_assignment_close_plan_warnings(messages, assignment_adjustments, underlying_legs)

        option_request = replace(request, legs=option_legs)
        return {
            'optionRequest': option_request,
            'underlyingLegs': underlying_legs,
            'assignmentAdjustments': assignment_adjustments,
            'messages': messages,
        }

    def _build_staged_underlying_preview(
        self,
        request,
        leg_request,
        qualified_contract,
        quote,
        order,
        status_message='',
        assignment_adjustments=None,
        staged_orders=None,
        close_plan_complete=False,
    ):
        preview_leg = ComboPreviewLeg(
            id=leg_request.id,
            symbol=getattr(qualified_contract, 'symbol', '') or leg_request.symbol,
            local_symbol=getattr(qualified_contract, 'localSymbol', '') or getattr(qualified_contract, 'symbol', ''),
            sec_type=getattr(qualified_contract, 'secType', '') or leg_request.sec_type,
            ratio=abs(int(leg_request.pos or 0)),
            mark=quote.get('mark'),
            target_position=int(leg_request.pos or 0),
            execution_action='BUY' if int(leg_request.pos or 0) > 0 else 'SELL',
            combo_leg_action='',
        )
        return ComboOrderPreview(
            group_id=request.group_id,
            group_name=request.group_name,
            combo_symbol=request.underlying_symbol or leg_request.symbol,
            combo_exchange=leg_request.exchange or getattr(qualified_contract, 'exchange', '') or 'SMART',
            order_action=order.action,
            total_quantity=int(order.totalQuantity),
            limit_price=getattr(order, 'lmtPrice', None),
            pricing_source='underlying_first',
            raw_net_mid=round(float(quote.get('mark') or 0), 4),
            time_in_force=order.tif,
            execution_mode=request.execution_mode or 'submit',
            account=str(getattr(order, 'account', '') or request.account or '').strip(),
            execution_intent=request.execution_intent or 'close',
            request_source='close_group_underlying' if not close_plan_complete else 'close_group',
            pricing_note=status_message,
            close_plan_stage='underlying',
            close_plan_complete=close_plan_complete,
            close_plan_message=status_message,
            assignment_adjustments=list(assignment_adjustments or []),
            staged_orders=list(staged_orders or []),
            legs=[preview_leg],
        )

    def _format_close_plan_message(self, close_plan, prefix=''):
        parts = []
        if prefix:
            parts.append(str(prefix).strip())
        parts.extend(str(message).strip() for message in (close_plan.get('messages') or []) if str(message).strip())
        return ' '.join(parts)

    def _apply_close_plan_metadata(self, preview, close_plan, staged_orders=None, stage=None, complete=None, prefix=''):
        if close_plan.get('assignmentAdjustments'):
            preview.assignment_adjustments = close_plan.get('assignmentAdjustments') or []
        if staged_orders:
            preview.staged_orders = list(staged_orders)
        if stage:
            preview.close_plan_stage = stage
        if complete is not None:
            preview.close_plan_complete = complete
        close_plan_message = self._format_close_plan_message(close_plan, prefix)
        if close_plan_message:
            preview.close_plan_message = close_plan_message
            if preview.pricing_note:
                preview.pricing_note = f"{preview.pricing_note} {close_plan_message}"
            else:
                preview.pricing_note = close_plan_message

    async def _build_underlying_first_preview(self, websocket, request, close_plan):
        staged_orders = []
        first_stage = None
        for leg_request in close_plan.get('underlyingLegs') or []:
            qualified_contract, quote = await self._resolve_leg_contract_and_mark(websocket, leg_request)
            order_action = 'BUY' if int(leg_request.pos or 0) > 0 else 'SELL'
            raw_limit = self._resolve_underlying_close_raw_limit(request, quote, order_action)
            price_increment = await self._resolve_contract_price_increment(
                qualified_contract,
                getattr(qualified_contract, 'exchange', '') or leg_request.exchange,
                raw_limit,
                self._resolve_combo_price_increment(request=request),
            )
            order = self._build_underlying_close_order(
                request,
                leg_request,
                quote,
                price_increment=price_increment,
                raw_limit=raw_limit,
            )
            staged_order = {
                'stage': 'underlying',
                'status': 'Previewed',
                'orderAction': order.action,
                'quantity': int(order.totalQuantity),
                'limitPrice': getattr(order, 'lmtPrice', None),
                'priceIncrement': price_increment,
                'legId': leg_request.id,
                'secType': getattr(qualified_contract, 'secType', '') or leg_request.sec_type,
                'symbol': getattr(qualified_contract, 'symbol', '') or leg_request.symbol,
            }
            staged_orders.append(staged_order)
            if first_stage is None:
                first_stage = {
                    'legRequest': leg_request,
                    'qualifiedContract': qualified_contract,
                    'quote': quote,
                    'order': order,
                    'priceIncrement': price_increment,
                }

        if first_stage is None:
            raise ValueError('No assignment/deliverable underlying legs were available to preview.')

        preview = self._build_staged_underlying_preview(
            request,
            first_stage['legRequest'],
            first_stage['qualifiedContract'],
            first_stage['quote'],
            first_stage['order'],
            status_message='',
            assignment_adjustments=close_plan.get('assignmentAdjustments'),
            staged_orders=staged_orders,
            close_plan_complete=False,
        )
        self._apply_close_plan_metadata(
            preview,
            close_plan,
            staged_orders=staged_orders,
            stage='underlying',
            complete=False,
            prefix=(
                'Close preview reflects the first assignment/deliverable underlying order; '
                'remaining option legs are handled only after that underlying stage fills.'
            ),
        )
        if request.execution_mode == 'test_submit':
            preview.pricing_source = 'test_guardrail'
        preview.price_increment = first_stage.get('priceIncrement')
        return {
            'contract': first_stage['qualifiedContract'],
            'order': first_stage['order'],
            'preview': preview,
        }

    def _build_underlying_close_order(self, request, leg_request, quote, price_increment=None, raw_limit=None):
        order = Order()
        order.action = 'BUY' if int(leg_request.pos or 0) > 0 else 'SELL'
        order.orderType = 'LMT'
        order.totalQuantity = abs(int(leg_request.pos or 0))
        order.tif = self._resolve_time_in_force(request)
        order.transmit = True
        if raw_limit is None:
            raw_limit = self._resolve_underlying_close_raw_limit(request, quote, order.action)
        order.lmtPrice = self._quantize_underlying_limit_price(raw_limit, order.action, price_increment)
        if str(request.account or '').strip():
            order.account = str(request.account).strip()
        return order

    def _resolve_underlying_close_raw_limit(self, request, quote, order_action):
        if request.execution_mode == 'test_submit':
            mark = quote.get('mark')
            direct_mid = float(mark or 0) if order_action == 'BUY' else -float(mark or 0)
            raw_limit, _pricing_source, _pricing_note = self._resolve_limit_pricing(
                request,
                direct_mid,
                order_action,
            )
        else:
            raw_limit = quote.get('ask') if order_action == 'BUY' else quote.get('bid')
            if raw_limit is None:
                raw_limit = quote.get('mark')
        return raw_limit

    def _quantize_underlying_limit_price(self, raw_price, order_action, price_increment=None):
        increment = Decimal(str(self._safe_positive_float(price_increment) or self.default_price_increment))
        price_decimal = Decimal(str(max(float(raw_price), float(increment))))
        rounding = ROUND_CEILING if order_action == 'BUY' else ROUND_FLOOR
        step_count = (price_decimal / increment).to_integral_value(rounding=rounding)
        quantized = max(step_count * increment, increment)
        decimals = max(0, -increment.normalize().as_tuple().exponent)
        return round(float(quantized), decimals)

    def _extract_filled_average_price(self, trade):
        order_status = getattr(trade, 'orderStatus', None)
        try:
            avg_fill_price = float(getattr(order_status, 'avgFillPrice', None) or 0)
        except (TypeError, ValueError):
            avg_fill_price = 0.0
        if avg_fill_price > 0:
            return round(avg_fill_price, 4)

        fills = list(getattr(trade, 'fills', None) or [])
        total_quantity = 0.0
        total_notional = 0.0
        for fill in fills:
            execution = getattr(fill, 'execution', None)
            if execution is None:
                continue
            try:
                quantity = abs(float(getattr(execution, 'shares', 0) or 0))
                price = abs(float(getattr(execution, 'price', 0) or 0))
            except (TypeError, ValueError):
                continue
            if quantity <= 0 or price <= 0:
                continue
            total_quantity += quantity
            total_notional += quantity * price
        if total_quantity > 0:
            return round(total_notional / total_quantity, 4)
        return None

    async def _submit_underlying_first_close_plan(self, websocket, request, close_plan):
        staged_orders = []
        for leg_request in close_plan.get('underlyingLegs') or []:
            qualified_contract, quote = await self._resolve_leg_contract_and_mark(websocket, leg_request)
            order_action = 'BUY' if int(leg_request.pos or 0) > 0 else 'SELL'
            raw_limit = self._resolve_underlying_close_raw_limit(request, quote, order_action)
            price_increment = await self._resolve_contract_price_increment(
                qualified_contract,
                getattr(qualified_contract, 'exchange', '') or leg_request.exchange,
                raw_limit,
                self._resolve_combo_price_increment(request=request),
            )
            order = self._build_underlying_close_order(
                request,
                leg_request,
                quote,
                price_increment=price_increment,
                raw_limit=raw_limit,
            )
            self.logger.info(
                f"Submitting close-group underlying-first order groupId={request.group_id}: "
                f"id={leg_request.id} secType={leg_request.sec_type} symbol={leg_request.symbol} "
                f"action={order.action} qty={order.totalQuantity} limit={order.lmtPrice} "
                f"account={getattr(order, 'account', '') or ''}"
            )
            trade = self.ib.placeOrder(qualified_contract, order)
            tracking_legs = [{
                'id': leg_request.id,
                'conId': getattr(qualified_contract, 'conId', None),
                'localSymbol': getattr(qualified_contract, 'localSymbol', ''),
                'symbol': getattr(qualified_contract, 'symbol', '') or leg_request.symbol,
                'secType': getattr(qualified_contract, 'secType', '') or leg_request.sec_type,
                'right': '',
                'strike': None,
                'expDate': '',
                'targetPosition': int(leg_request.pos or 0),
                'expectedExecutionSide': 'BOT' if int(leg_request.pos or 0) > 0 else 'SLD',
                'ratio': abs(int(leg_request.pos or 0)),
            }]
            staged_request = replace(request, request_source='close_group_underlying', legs=[leg_request])
            placement_tracking = None
            if callable(self.on_combo_order_placed):
                try:
                    placement_tracking = self.on_combo_order_placed(
                        websocket,
                        staged_request,
                        trade,
                        tracking_legs,
                    )
                except Exception:
                    self.logger.exception(
                        f"Failed to pre-register underlying close tracking for groupId={request.group_id}"
                    )

            await asyncio.sleep(self.underlying_close_settle_seconds)
            order_status = getattr(trade, 'orderStatus', None)
            tracked_status = placement_tracking.get('status') if isinstance(placement_tracking, dict) else None
            status = str(tracked_status or getattr(order_status, 'status', '') or '').strip()
            status_message = (
                self._extract_trade_status_message(trade)
                or (str(placement_tracking.get('statusMessage') or '').strip() if isinstance(placement_tracking, dict) else '')
            )
            avg_fill_price = self._extract_filled_average_price(trade)
            order_id = getattr(getattr(trade, 'order', None), 'orderId', None)
            perm_id = getattr(order_status, 'permId', None)
            staged_orders.append({
                'stage': 'underlying',
                'orderId': order_id,
                'permId': perm_id,
                'status': status,
                'orderAction': order.action,
                'quantity': int(order.totalQuantity),
                'limitPrice': getattr(order, 'lmtPrice', None),
                'priceIncrement': price_increment,
                'legId': leg_request.id,
                'secType': getattr(qualified_contract, 'secType', '') or leg_request.sec_type,
                'symbol': getattr(qualified_contract, 'symbol', '') or leg_request.symbol,
                'avgFillPrice': avg_fill_price,
            })

            for adjustment in close_plan.get('assignmentAdjustments') or []:
                if adjustment.get('underlyingLegId') == leg_request.id and avg_fill_price is not None:
                    adjustment['underlyingAvgFillPrice'] = avg_fill_price
                    adjustment['underlyingOrderId'] = order_id
                    adjustment['underlyingPermId'] = perm_id

            filled = status == 'Filled'
            if not filled:
                message = status_message or (
                    'Underlying close order is working; option close was not submitted yet. '
                    'After the underlying fill is reflected, run Close Group again for the remaining option legs.'
                )
                preview = self._build_staged_underlying_preview(
                    request,
                    leg_request,
                    qualified_contract,
                    quote,
                    order,
                    status_message=message,
                    assignment_adjustments=close_plan.get('assignmentAdjustments'),
                    staged_orders=staged_orders,
                    close_plan_complete=False,
                )
                return {
                    'completed': False,
                    'result': ComboSubmitResult(
                        preview=preview,
                        order_id=order_id,
                        perm_id=perm_id,
                        status=status or getattr(order_status, 'status', None),
                        status_message=message,
                        tracking_legs=tracking_legs,
                        trade=trade,
                    ),
                    'stagedOrders': staged_orders,
                }

        return {
            'completed': True,
            'stagedOrders': staged_orders,
        }

    def _resolve_limit_pricing(self, request, direct_net_mid, order_action):
        abs_mid = round(abs(direct_net_mid), 4)
        min_limit_price = self._resolve_combo_price_increment(request=request)

        if request.execution_mode != 'test_submit':
            return abs_mid, 'middle', ''

        if order_action == 'BUY':
            test_price = abs_mid * self.test_only_buy_factor
            if abs_mid >= 1.0:
                test_price = min(test_price, abs_mid - 1.0)
            else:
                test_price = min(test_price, max(abs_mid - 0.05, min_limit_price))
            test_price = max(test_price, min_limit_price)
            note = 'Test-only guardrail price intentionally set far below the combo mid to avoid fills.'
        else:
            test_price = abs_mid * self.test_only_sell_factor
            if abs_mid >= 1.0:
                test_price = max(test_price, abs_mid + 1.0)
            else:
                test_price = max(test_price, abs_mid + self.test_only_small_credit_buffer)
            note = 'Test-only guardrail price intentionally set far above the combo mid to avoid fills.'

        return round(test_price, 4), 'test_guardrail', note

    def _quantize_limit_price(self, raw_price, order_action, price_increment=None):
        increment = Decimal(str(self._resolve_combo_price_increment(context={
            'priceIncrement': price_increment,
        })))
        min_price = increment
        price_decimal = Decimal(str(max(float(raw_price), float(min_price))))
        if order_action == 'BUY':
            step_count = (price_decimal / increment).to_integral_value(rounding=ROUND_FLOOR)
        else:
            step_count = (price_decimal / increment).to_integral_value(rounding=ROUND_CEILING)

        quantized = step_count * increment
        if quantized < min_price:
            min_steps = (min_price / increment).to_integral_value(rounding=ROUND_CEILING)
            quantized = min_steps * increment

        decimals = max(0, -increment.normalize().as_tuple().exponent)
        return round(float(quantized), decimals)

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

        if len(resolved_legs) == 1:
            leg = resolved_legs[0]
            leg['ratio'] = 1
            leg['comboLegAction'] = ''
            single_contract = leg['contract']
            order = Order()
            order.action = 'BUY' if leg['pos'] > 0 else 'SELL'
            order.orderType = 'LMT'
            order.totalQuantity = abs(int(leg['pos']))
            limit_price, pricing_source, pricing_note = self._resolve_limit_pricing(
                request,
                direct_net_mid,
                order.action,
            )
            price_increment = await self._resolve_order_price_increment(
                request,
                resolved_legs,
                order.action,
                limit_price,
                combo_exchange,
            )
            order.lmtPrice = self._quantize_limit_price(limit_price, order.action, price_increment)
            order.tif = self._resolve_time_in_force(request)
            order.transmit = True
            if str(request.account or '').strip():
                order.account = str(request.account).strip()

            if pricing_note:
                pricing_note = f"{pricing_note} Single remaining leg routed as a regular order instead of BAG."
            else:
                pricing_note = 'Single remaining leg routed as a regular order instead of BAG.'

            preview_legs = [ComboPreviewLeg(
                id=leg['request'].id,
                symbol=getattr(single_contract, 'symbol', ''),
                local_symbol=getattr(single_contract, 'localSymbol', ''),
                sec_type=getattr(single_contract, 'secType', ''),
                ratio=1,
                mark=leg['quote']['mark'],
                target_position=leg['pos'],
                execution_action=order.action,
                combo_leg_action='',
            )]
            quote_bounds = self._compute_quote_bounds_from_resolved_legs(resolved_legs)
            preview = ComboOrderPreview(
                group_id=request.group_id,
                group_name=request.group_name,
                combo_symbol=getattr(single_contract, 'symbol', '') or combo_symbol,
                combo_exchange=getattr(single_contract, 'exchange', '') or combo_exchange,
                order_action=order.action,
                total_quantity=order.totalQuantity,
                limit_price=order.lmtPrice,
                pricing_source=pricing_source,
                raw_net_mid=round(direct_net_mid, 4),
                time_in_force=order.tif,
                execution_mode=request.execution_mode or 'preview',
                account=str(getattr(order, 'account', '') or request.account or '').strip(),
                execution_intent=request.execution_intent or 'open',
                request_source=request.request_source or 'manual',
                pricing_note=pricing_note,
                managed_concession_ratio=float(request.managed_concession_ratio or 0.0),
                best_combo_price=quote_bounds['bestPrice'] if quote_bounds else None,
                worst_combo_price=quote_bounds['worstPrice'] if quote_bounds else None,
                legs=preview_legs,
            )
            preview.price_increment = price_increment
            return {
                'comboContract': single_contract,
                'order': order,
                'preview': preview,
                'resolvedLegs': resolved_legs,
                'priceIncrement': price_increment,
                'rawLimitPrice': limit_price,
            }

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
        price_increment = await self._resolve_order_price_increment(
            request,
            resolved_legs,
            order_action,
            limit_price,
            combo_exchange,
        )
        order.lmtPrice = self._quantize_limit_price(limit_price, order_action, price_increment)
        order.tif = self._resolve_time_in_force(request)
        order.transmit = True
        if str(request.account or '').strip():
            order.account = str(request.account).strip()

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
            account=str(getattr(order, 'account', '') or request.account or '').strip(),
            execution_intent=request.execution_intent or 'open',
            request_source=request.request_source or 'manual',
            pricing_note=pricing_note,
            managed_concession_ratio=float(request.managed_concession_ratio or 0.0),
            best_combo_price=quote_bounds['bestPrice'] if quote_bounds else None,
            worst_combo_price=quote_bounds['worstPrice'] if quote_bounds else None,
            legs=preview_legs,
        )
        preview.price_increment = price_increment
        return {
            'comboContract': combo_contract,
            'order': order,
            'preview': preview,
            'resolvedLegs': resolved_legs,
            'priceIncrement': price_increment,
            'rawLimitPrice': limit_price,
        }

    async def validate_combo_order(self, websocket, request):
        close_plan = self._build_assignment_aware_close_plan(request)
        validation_legs_to_check = list((close_plan.get('underlyingLegs') or []))
        option_request = close_plan.get('optionRequest') or request
        validation_legs_to_check.extend(option_request.legs or [])

        if not validation_legs_to_check:
            raise ValueError('No combo legs were provided.')

        validation_legs = []
        non_zero_legs = 0
        for leg_request in validation_legs_to_check:
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

    validate_hedge_order = validate_hedge_order
    preview_hedge_order = preview_hedge_order
    submit_hedge_order = submit_hedge_order
    cancel_hedge_order = cancel_hedge_order

    async def preview_combo_order(self, websocket, request):
        close_plan = self._build_assignment_aware_close_plan(request)
        if close_plan.get('underlyingLegs'):
            stage_result = await self._build_underlying_first_preview(websocket, request, close_plan)
            combo_contract = stage_result['contract']
            order = stage_result['order']
            preview = stage_result['preview']
        else:
            request = close_plan.get('optionRequest') or request
            if not request.legs and (
                close_plan.get('assignmentAdjustments')
                or close_plan.get('underlyingLegs')
                or close_plan.get('messages')
            ):
                raise ValueError(
                    self._format_close_plan_message(
                        close_plan,
                        'Assignment-aware Close found no live option or underlying position to preview.'
                    )
                )
            build_result = await self._build_combo_order_from_request(websocket, request)
            combo_contract = build_result['comboContract']
            order = build_result['order']
            preview = build_result['preview']
            self._apply_close_plan_metadata(
                preview,
                close_plan,
                stage='options' if close_plan.get('assignmentAdjustments') else None,
                prefix='Close preview excludes assigned/exercised contracts and shows remaining live option legs.'
                if close_plan.get('assignmentAdjustments') else '',
            )
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

    def _append_combo_pricing_note(self, preview, message):
        message = str(message or '').strip()
        if not message:
            return
        if preview.pricing_note:
            preview.pricing_note = f"{preview.pricing_note} {message}"
        else:
            preview.pricing_note = message

    def _build_combo_tracking_legs(self, resolved_legs):
        return [
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

    def _extract_combo_submit_attempt_state(self, trade, placement_tracking):
        order_status = getattr(trade, 'orderStatus', None)
        tracked_status_message = ''
        tracked_status = None
        if isinstance(placement_tracking, dict):
            tracked_status_message = str(placement_tracking.get('statusMessage') or '').strip()
            tracked_status = placement_tracking.get('status')
        status_message = self._extract_trade_status_message(trade) or tracked_status_message
        final_status = getattr(order_status, 'status', None)
        if self._is_terminal_order_status(tracked_status):
            final_status = tracked_status
        elif final_status in (None, '') and tracked_status:
            final_status = tracked_status
        return {
            'status': final_status,
            'statusMessage': status_message,
            'orderId': getattr(getattr(trade, 'order', None), 'orderId', None),
            'permId': getattr(order_status, 'permId', None),
        }

    def _build_combo_attempt_stage(self, attempt, price_increment, retry_reason=''):
        order = attempt.get('order')
        stage = {
            'stage': 'combo',
            'attempt': attempt.get('attemptNumber'),
            'orderId': attempt.get('orderId'),
            'permId': attempt.get('permId'),
            'status': attempt.get('status'),
            'orderAction': getattr(order, 'action', None),
            'quantity': getattr(order, 'totalQuantity', None),
            'limitPrice': getattr(order, 'lmtPrice', None),
            'priceIncrement': price_increment,
        }
        status_message = str(attempt.get('statusMessage') or '').strip()
        if status_message:
            stage['statusMessage'] = status_message
        if retry_reason:
            stage['retryReason'] = retry_reason
        return {key: value for key, value in stage.items() if value is not None and value != ''}

    async def _place_combo_order_attempt(
        self,
        websocket,
        request,
        combo_contract,
        order,
        resolved_legs,
        price_increment=None,
        attempt_number=1,
        retry_reason='',
    ):
        attempt_label = 'Retrying' if attempt_number > 1 else 'Placing'
        increment_text = self._format_price_increment(price_increment)
        retry_detail = f" retryReason={retry_reason}" if retry_reason else ''
        increment_detail = f" priceIncrement={increment_text}" if increment_text else ''
        self.logger.info(
            f"{attempt_label} combo order for groupId={request.group_id}: "
            f"executionMode={request.execution_mode} action={order.action} qty={order.totalQuantity} "
            f"limit={order.lmtPrice} tif={order.tif} account={getattr(order, 'account', '') or ''}"
            f"{increment_detail}{retry_detail}"
        )
        trade = self.ib.placeOrder(combo_contract, order)
        tracking_legs = self._build_combo_tracking_legs(resolved_legs)
        # Pre-register fill tracking synchronously (no await between placeOrder
        # and here) so execution reports arriving during the settle sleep below
        # can still be attributed to the right legs.
        placement_tracking = None
        if callable(self.on_combo_order_placed):
            try:
                placement_tracking = self.on_combo_order_placed(websocket, request, trade, tracking_legs)
            except Exception:
                self.logger.exception(
                    f"Failed to pre-register combo order tracking for groupId={request.group_id}"
                )
        await asyncio.sleep(1.5)
        attempt = self._extract_combo_submit_attempt_state(trade, placement_tracking)
        attempt.update({
            'trade': trade,
            'order': order,
            'trackingLegs': tracking_legs,
            'placementTracking': placement_tracking,
            'priceIncrement': price_increment,
            'attemptNumber': attempt_number,
        })
        return attempt

    async def submit_combo_order(self, websocket, request):
        close_plan = self._build_assignment_aware_close_plan(request)
        staged_orders = []
        if close_plan.get('underlyingLegs'):
            underlying_stage = await self._submit_underlying_first_close_plan(websocket, request, close_plan)
            staged_orders = underlying_stage.get('stagedOrders') or []
            if not underlying_stage.get('completed'):
                return underlying_stage['result']
            request = close_plan['optionRequest']
            if not request.legs:
                message = (
                    'Close Group completed after closing assignment/deliverable underlying first; '
                    'no live option legs remained to submit.'
                )
                plan_message = self._format_close_plan_message(close_plan, message)
                last_stage = staged_orders[-1] if staged_orders else {}
                preview = ComboOrderPreview(
                    group_id=request.group_id,
                    group_name=request.group_name,
                    combo_symbol=request.underlying_symbol,
                    combo_exchange=(last_stage.get('exchange') or 'SMART'),
                    order_action=last_stage.get('orderAction') or '',
                    total_quantity=last_stage.get('quantity') or 0,
                    limit_price=last_stage.get('limitPrice') or 0,
                    pricing_source='underlying_first',
                    raw_net_mid=last_stage.get('avgFillPrice') or 0,
                    time_in_force=request.time_in_force or 'DAY',
                    execution_mode=request.execution_mode or 'submit',
                    account=str(request.account or '').strip(),
                    execution_intent=request.execution_intent or 'close',
                    request_source='close_group',
                    pricing_note=plan_message,
                    close_plan_stage='complete',
                    close_plan_complete=True,
                    close_plan_message=plan_message,
                    assignment_adjustments=close_plan.get('assignmentAdjustments') or [],
                    staged_orders=staged_orders,
                    legs=[],
                )
                return ComboSubmitResult(
                    preview=preview,
                    order_id=last_stage.get('orderId'),
                    perm_id=last_stage.get('permId'),
                    status='Filled',
                    status_message=plan_message,
                    tracking_legs=[],
                    trade=None,
                )
        elif close_plan is not None:
            request = close_plan.get('optionRequest') or request

        if not request.legs and (
            close_plan.get('assignmentAdjustments')
            or close_plan.get('underlyingLegs')
            or close_plan.get('messages')
        ):
            raise ValueError(
                self._format_close_plan_message(
                    close_plan,
                    'Assignment-aware Close found no live option or underlying position to submit.'
                )
            )

        build_result = await self._build_combo_order_from_request(websocket, request)
        combo_contract = build_result['comboContract']
        order = build_result['order']
        preview = build_result['preview']
        if staged_orders:
            self._apply_close_plan_metadata(
                preview,
                close_plan,
                staged_orders=staged_orders,
                stage='options',
                prefix='Assignment/deliverable underlying was closed first; submitted remaining option combo.',
            )
        else:
            self._apply_close_plan_metadata(
                preview,
                close_plan,
                stage='options' if close_plan.get('assignmentAdjustments') else None,
                prefix='Close submit excludes assigned/exercised contracts and submits remaining live option legs.'
                if close_plan.get('assignmentAdjustments') else '',
            )
        resolved_legs = build_result['resolvedLegs']
        self._log_combo_preview_summary(
            f"{'Submitting TEST-ONLY combo' if request.execution_mode == 'test_submit' else 'Submitting combo'} groupId={request.group_id}",
            preview,
        )
        price_increment = self._safe_positive_float(
            build_result.get('priceIncrement') or getattr(preview, 'price_increment', None)
        )
        raw_limit_price = build_result.get('rawLimitPrice')
        if raw_limit_price is None:
            raw_limit_price = getattr(order, 'lmtPrice', None)

        attempt = await self._place_combo_order_attempt(
            websocket,
            request,
            combo_contract,
            order,
            resolved_legs,
            price_increment=price_increment,
            attempt_number=1,
        )
        final_attempt = attempt
        retry_stages = []

        if self._is_min_price_variation_reject(attempt.get('status'), attempt.get('statusMessage')):
            retry_stages.append(self._build_combo_attempt_stage(
                attempt,
                price_increment,
                retry_reason='minimum_price_variation',
            ))
            last_limit = self._safe_positive_float(getattr(order, 'lmtPrice', None)) or 0.0
            next_attempt_number = 2
            for retry_increment in self._coarser_price_increment_candidates(price_increment):
                retry_limit = self._quantize_limit_price(
                    raw_limit_price,
                    order.action,
                    retry_increment,
                )
                if abs(float(retry_limit) - float(last_limit)) < 1e-9:
                    continue
                retry_order = self._clone_order_for_limit_retry(order, retry_limit)
                retry_attempt = await self._place_combo_order_attempt(
                    websocket,
                    request,
                    combo_contract,
                    retry_order,
                    resolved_legs,
                    price_increment=retry_increment,
                    attempt_number=next_attempt_number,
                    retry_reason='minimum_price_variation',
                )
                retry_stages.append(self._build_combo_attempt_stage(
                    retry_attempt,
                    retry_increment,
                    retry_reason='minimum_price_variation',
                ))
                final_attempt = retry_attempt
                price_increment = retry_increment
                last_limit = retry_limit
                next_attempt_number += 1
                if not self._is_min_price_variation_reject(
                    retry_attempt.get('status'),
                    retry_attempt.get('statusMessage'),
                ):
                    break

        if retry_stages:
            preview.staged_orders = list(preview.staged_orders or []) + retry_stages
            final_order = final_attempt.get('order') or order
            final_limit = getattr(final_order, 'lmtPrice', None)
            if final_limit is not None:
                preview.limit_price = final_limit
            preview.price_increment = self._safe_positive_float(
                final_attempt.get('priceIncrement') or price_increment
            )
            final_increment_text = self._format_price_increment(preview.price_increment)
            final_limit_text = getattr(final_order, 'lmtPrice', None)
            if self._is_min_price_variation_reject(
                final_attempt.get('status'),
                final_attempt.get('statusMessage'),
            ):
                self._append_combo_pricing_note(
                    preview,
                    'TWS rejected the combo limit for minimum price variation; '
                    'the backend retried with coarser tick sizes but TWS still rejected the latest price.'
                )
            else:
                self._append_combo_pricing_note(
                    preview,
                    f"TWS rejected the initial combo limit for minimum price variation; "
                    f"the backend resubmitted at {final_limit_text} using "
                    f"{final_increment_text or 'a coarser'} tick size."
                )

        trade = final_attempt['trade']
        tracking_legs = final_attempt['trackingLegs']
        managed_context = None
        if not self._is_min_price_variation_reject(
            final_attempt.get('status'),
            final_attempt.get('statusMessage'),
        ):
            managed_context = self._register_managed_context(
                websocket,
                request,
                combo_contract,
                trade,
                preview,
                resolved_legs,
            )
        status_message = final_attempt.get('statusMessage') or ''
        final_status = final_attempt.get('status')
        if retry_stages and self._is_min_price_variation_reject(final_status, status_message):
            status_message = (
                'TWS rejected the combo limit for minimum price variation after retrying coarser tick sizes. '
                f"Latest TWS message: {status_message}"
                if status_message
                else 'TWS rejected the combo limit for minimum price variation after retrying coarser tick sizes.'
            )
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
        result = ComboSubmitResult(
            preview=preview,
            order_id=final_attempt.get('orderId'),
            perm_id=final_attempt.get('permId'),
            status=final_status,
            status_message=status_message or None,
            tracking_legs=tracking_legs,
            trade=trade,
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

    def _iter_unique_managed_contexts(self):
        seen_context_ids = set()
        contexts = list(self.managed_executions_by_order_id.values()) + list(self.managed_executions_by_perm_id.values())
        for context in contexts:
            context_identity = id(context)
            if context_identity in seen_context_ids:
                continue
            seen_context_ids.add(context_identity)
            yield context

    def _iter_unique_hedge_contexts(self):
        seen_context_ids = set()
        contexts = list(self.hedge_orders_by_order_id.values()) + list(self.hedge_orders_by_perm_id.values())
        for context in contexts:
            context_identity = id(context)
            if context_identity in seen_context_ids:
                continue
            seen_context_ids.add(context_identity)
            yield context

    def release_managed_for_websocket(self, websocket):
        """Orphan (do not terminate) supervision owned by a disconnected session.

        The broker order is still live in TWS, so the reprice loop keeps
        supervising it server-side; status emits are skipped until a
        reconnected session adopts the context via
        adopt_managed_combo_order().
        """
        for context in self._iter_unique_managed_contexts():
            if context.get('websocket') is websocket:
                context['websocket'] = None
                context['lastManagedEmitSignature'] = None

        for context in self._iter_unique_hedge_contexts():
            if context.get('websocket') is websocket:
                context['websocket'] = None

    # Backwards-compatible alias for older callers.
    cancel_managed_for_websocket = release_managed_for_websocket

    def adopt_managed_combo_order(self, websocket, order_id, perm_id):
        """Adopt one orphaned managed context into a reconnected session.

        Adoption is per-order (driven by the account/group-filtered combo
        snapshot) so one reconnecting tab cannot claim supervision contexts
        that belong to another live session. Contexts still owned by a live
        websocket are left untouched.
        """
        context = self._resolve_order_tracking(order_id, perm_id)
        if context is None:
            return False
        if context.get('websocket') is None:
            context['websocket'] = websocket
            context['lastManagedEmitSignature'] = None
            return True
        return context.get('websocket') is websocket

    def _adopt_or_verify_context_session(self, context, websocket, error_message):
        owner = context.get('websocket')
        if owner is None:
            context['websocket'] = websocket
            context['lastManagedEmitSignature'] = None
            return
        if owner is not websocket:
            raise ValueError(error_message)

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

        self._adopt_or_verify_context_session(
            context,
            websocket,
            'Managed combo order belongs to a different session.',
        )

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
                f'with drift threshold '
                f'{self._format_managed_reprice_threshold(context.get("managedRepriceThreshold") or self.managed_reprice_threshold)}.'
            )
        task = context.get('task')
        if task and not task.done():
            task.cancel()
        context['task'] = asyncio.create_task(self._managed_reprice_loop(context))
        await self._emit_managed_update(context)
        self.logger.info(
            f"Resumed managed combo repricing for groupId={group_id} "
            f"orderId={context.get('orderId')} permId={context.get('permId')} account={context.get('account') or ''} "
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

        self._adopt_or_verify_context_session(
            context,
            websocket,
            'Managed combo order belongs to a different session.',
        )

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
        new_limit = self._quantize_limit_price(
            target_limit_source,
            context.get('orderAction'),
            context.get('priceIncrement'),
        )

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
            f"orderId={context.get('orderId')} permId={context.get('permId')} account={context.get('account') or ''} "
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

        self._adopt_or_verify_context_session(
            context,
            websocket,
            'Managed combo order belongs to a different session.',
        )

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
            f"orderId={context.get('orderId')} permId={context.get('permId')} account={context.get('account') or ''} reason={reason}"
        )
        return self._build_managed_snapshot(context)
