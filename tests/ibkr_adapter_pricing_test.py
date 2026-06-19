import asyncio
import pathlib
import sys
import types
import unittest
from types import SimpleNamespace


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


try:
    import ib_async  # noqa: F401
except ImportError:
    ib_async = types.ModuleType('ib_async')

    class _SimpleIbObject:
        def __init__(self, *args, **kwargs):
            for key, value in kwargs.items():
                setattr(self, key, value)

    ib_async.ComboLeg = _SimpleIbObject
    ib_async.Contract = _SimpleIbObject
    ib_async.Order = _SimpleIbObject
    ib_async.Stock = _SimpleIbObject
    ib_async.TagValue = _SimpleIbObject

    class _DummyEvent:
        def __init__(self):
            self.handlers = []

        def __iadd__(self, handler):
            self.handlers.append(handler)
            return self

        def __isub__(self, handler):
            if handler in self.handlers:
                self.handlers.remove(handler)
            return self

    class _DummyIB:
        def __init__(self):
            self.updatePortfolioEvent = _DummyEvent()
            self.orderStatusEvent = _DummyEvent()
            self.execDetailsEvent = _DummyEvent()
            self.errorEvent = _DummyEvent()

        def isConnected(self):
            return False

        def managedAccounts(self):
            return []

        def reqMarketDataType(self, *_args, **_kwargs):
            return None

    ib_async.IB = _DummyIB
    sys.modules['ib_async'] = ib_async


from trade_execution.adapters.ibkr import IbkrExecutionAdapter
from trade_execution.models import (
    ComboLegRequest,
    ComboOrderPreview,
    ComboOrderRequest,
    HedgeOrderPreview,
    HedgeOrderRequest,
    HedgeSubmitResult,
)
import ib_server


class _DummyEvent:
    def __iadd__(self, handler):
        self.handler = handler
        return self


class _DummyIb:
    def __init__(self):
        self.orderStatusEvent = _DummyEvent()


class IbkrAdapterPricingTests(unittest.TestCase):
    def setUp(self):
        self.adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
        )

    def _build_request(self, execution_mode, family='HG', price_increment=0.0005):
        return ComboOrderRequest(
            group_id='group_hg',
            group_name='HG Pricing Test',
            underlying_symbol=family,
            underlying_contract_month='202607',
            execution_mode=execution_mode,
            profile={
                'family': family,
                'priceIncrement': price_increment,
            },
        )

    def test_quantize_limit_price_respects_hg_half_tick_below_one_cent(self):
        quantized = self.adapter._quantize_limit_price(0.0034, 'BUY', 0.0005)
        self.assertEqual(quantized, 0.003)

    def test_quantize_limit_price_uses_one_tick_minimum_for_hg(self):
        quantized = self.adapter._quantize_limit_price(0.0004, 'BUY', 0.0005)
        self.assertEqual(quantized, 0.0005)

    def test_test_submit_buy_guardrail_uses_hg_tick_floor(self):
        request = self._build_request('test_submit')
        price, pricing_source, note = self.adapter._resolve_limit_pricing(request, 0.003, 'BUY')

        self.assertEqual(price, 0.0005)
        self.assertEqual(pricing_source, 'test_guardrail')
        self.assertIn('avoid fills', note)

    def test_standard_test_submit_buy_guardrail_still_uses_one_cent_floor(self):
        request = self._build_request('test_submit', family='SPY', price_increment=0.01)
        price, pricing_source, note = self.adapter._resolve_limit_pricing(request, 0.015, 'BUY')

        self.assertEqual(price, 0.01)
        self.assertEqual(pricing_source, 'test_guardrail')
        self.assertIn('avoid fills', note)

    def test_resolve_combo_price_increment_uses_default_when_es_has_no_family_increment(self):
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families=ib_server.SUPPORTED_LIVE_FAMILIES,
            index_exchange_fallbacks={},
        )
        request = ComboOrderRequest(
            group_id='group_es',
            group_name='ES Pricing Test',
            underlying_symbol='ES',
            underlying_contract_month='202606',
            execution_mode='preview',
            profile={
                'family': 'ES',
            },
        )

        self.assertEqual(adapter._resolve_combo_price_increment(request=request), 0.01)

    def test_select_increment_from_ib_market_rule_ladder(self):
        increments = [(0.0, 0.05), (3.0, 0.25)]

        self.assertEqual(self.adapter._select_increment_from_ladder(1.23, increments), 0.05)
        self.assertEqual(self.adapter._select_increment_from_ladder(65.63, increments), 0.25)

    def test_build_contract_from_request_preserves_micro_fop_multipliers_without_trading_class(self):
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families=ib_server.SUPPORTED_LIVE_FAMILIES,
            index_exchange_fallbacks={},
        )

        for symbol, multiplier in (('MES', '5'), ('MNQ', '2')):
            leg_request = ComboLegRequest.from_payload({
                'id': f'leg_{symbol.lower()}',
                'type': 'call',
                'pos': 1,
                'secType': 'FOP',
                'symbol': symbol,
                'underlyingSymbol': symbol,
                'exchange': 'CME',
                'underlyingExchange': 'CME',
                'currency': 'USD',
                'multiplier': multiplier,
                'underlyingMultiplier': multiplier,
                'right': 'C',
                'strike': '5400',
                'expDate': '20260619',
                'contractMonth': '202606',
                'underlyingContractMonth': '202606',
            })

            contract = adapter._build_contract_from_request(leg_request)
            self.assertEqual(getattr(contract, 'secType', ''), 'FOP')
            self.assertEqual(getattr(contract, 'symbol', ''), symbol)
            self.assertEqual(getattr(contract, 'exchange', ''), 'CME')
            self.assertEqual(getattr(contract, 'multiplier', ''), multiplier)
            self.assertEqual(getattr(contract, 'tradingClass', ''), '')

    def test_quantize_limit_price_respects_explicit_quarter_point_increment(self):
        quantized = self.adapter._quantize_limit_price(3.18, 'BUY', 0.25)
        self.assertEqual(quantized, 3.0)

    def test_quantize_limit_price_accepts_small_market_rule_increment(self):
        quantized = self.adapter._quantize_limit_price(1.23, 'BUY', 0.05)
        self.assertEqual(quantized, 1.2)

    def test_single_leg_order_uses_ib_market_rule_increment(self):
        class _MarketRuleIb(_DummyIb):
            async def reqContractDetailsAsync(self, contract):
                return [SimpleNamespace(
                    minTick=0.01,
                    validExchanges='SMART',
                    marketRuleIds='101',
                    contract=SimpleNamespace(exchange='SMART'),
                )]

            async def reqMarketRuleAsync(self, market_rule_id):
                if market_rule_id != 101:
                    raise AssertionError(f'unexpected market rule id {market_rule_id}')
                return [
                    SimpleNamespace(lowEdge=0, increment=0.05),
                    SimpleNamespace(lowEdge=3, increment=0.25),
                ]

        adapter = IbkrExecutionAdapter(
            ib=_MarketRuleIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
        )

        async def fake_resolve(_websocket, leg_request):
            return (
                SimpleNamespace(
                    conId=8801,
                    secType='FOP',
                    symbol='MES',
                    localSymbol='MES 260630C07560000',
                    exchange='SMART',
                    currency='USD',
                ),
                {'bid': 65.5, 'ask': 65.75, 'mark': 65.63},
            )

        adapter._resolve_leg_contract_and_mark = fake_resolve
        request = ComboOrderRequest(
            group_id='group_single_tick',
            group_name='Single Tick',
            underlying_symbol='MES',
            underlying_contract_month='202609',
            execution_mode='preview',
            profile={'family': 'MES', 'priceIncrement': 0.01},
            legs=[
                ComboLegRequest.from_payload({
                    'id': 'mes_call',
                    'type': 'call',
                    'pos': 10,
                    'secType': 'FOP',
                    'symbol': 'MES',
                    'exchange': 'CME',
                    'currency': 'USD',
                    'multiplier': '5',
                    'right': 'C',
                    'strike': 7560,
                    'expDate': '20260630',
                    'contractMonth': '202606',
                    'underlyingContractMonth': '202609',
                }),
            ],
        )

        result = asyncio.run(adapter._build_combo_order_from_request(object(), request))

        self.assertEqual(result['comboContract'].secType, 'FOP')
        self.assertEqual(result['order'].lmtPrice, 65.5)
        self.assertEqual(result['priceIncrement'], 0.25)
        self.assertEqual(getattr(result['preview'], 'price_increment'), 0.25)

    def test_bag_order_uses_smallest_leg_market_rule_increment(self):
        class _MarketRuleIb(_DummyIb):
            async def reqContractDetailsAsync(self, contract):
                rule_id = '101' if contract.conId == 8801 else '202'
                return [SimpleNamespace(
                    minTick=0.01,
                    validExchanges='SMART',
                    marketRuleIds=rule_id,
                    contract=SimpleNamespace(exchange='SMART'),
                )]

            async def reqMarketRuleAsync(self, market_rule_id):
                if market_rule_id == 101:
                    return [
                        SimpleNamespace(lowEdge=0, increment=0.05),
                        SimpleNamespace(lowEdge=3, increment=0.25),
                    ]
                return [SimpleNamespace(lowEdge=0, increment=0.1)]

        adapter = IbkrExecutionAdapter(
            ib=_MarketRuleIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
        )

        async def fake_resolve(_websocket, leg_request):
            con_id = 8801 if leg_request.id == 'leg_a' else 8802
            mark = 1.26 if leg_request.id == 'leg_a' else 1.27
            return (
                SimpleNamespace(
                    conId=con_id,
                    secType='FOP',
                    symbol='MES',
                    localSymbol=f'MES {con_id}',
                    exchange='SMART',
                    currency='USD',
                ),
                {'bid': mark - 0.01, 'ask': mark + 0.01, 'mark': mark},
            )

        adapter._resolve_leg_contract_and_mark = fake_resolve
        request = ComboOrderRequest(
            group_id='group_bag_tick',
            group_name='BAG Tick',
            underlying_symbol='MES',
            underlying_contract_month='202609',
            execution_mode='preview',
            profile={'family': 'MES', 'priceIncrement': 0.01},
            legs=[
                ComboLegRequest.from_payload({
                    'id': 'leg_a',
                    'type': 'call',
                    'pos': 1,
                    'secType': 'FOP',
                    'symbol': 'MES',
                    'exchange': 'CME',
                    'currency': 'USD',
                    'multiplier': '5',
                    'right': 'C',
                    'strike': 7560,
                    'expDate': '20260630',
                    'contractMonth': '202606',
                    'underlyingContractMonth': '202609',
                }),
                ComboLegRequest.from_payload({
                    'id': 'leg_b',
                    'type': 'put',
                    'pos': 1,
                    'secType': 'FOP',
                    'symbol': 'MES',
                    'exchange': 'CME',
                    'currency': 'USD',
                    'multiplier': '5',
                    'right': 'P',
                    'strike': 7560,
                    'expDate': '20260630',
                    'contractMonth': '202606',
                    'underlyingContractMonth': '202609',
                }),
            ],
        )

        result = asyncio.run(adapter._build_combo_order_from_request(object(), request))

        self.assertEqual(result['comboContract'].secType, 'BAG')
        self.assertEqual(result['priceIncrement'], 0.05)
        self.assertEqual(result['order'].lmtPrice, 2.5)

    def test_resolve_price_increment_reuses_learned_combo_tick(self):
        class _FineRuleIb(_DummyIb):
            async def reqContractDetailsAsync(self, contract):
                return [SimpleNamespace(
                    minTick=0.01,
                    validExchanges='CME',
                    marketRuleIds='101',
                    contract=SimpleNamespace(exchange='CME'),
                )]

            async def reqMarketRuleAsync(self, market_rule_id):
                return [SimpleNamespace(lowEdge=0, increment=0.05)]

        adapter = IbkrExecutionAdapter(
            ib=_FineRuleIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
        )
        resolved_legs = [
            {
                'request': SimpleNamespace(exchange='CME'),
                'contract': SimpleNamespace(conId=8801, exchange='CME'),
                'ratio': 1,
                'quote': {'mark': 1.26},
            },
            {
                'request': SimpleNamespace(exchange='CME'),
                'contract': SimpleNamespace(conId=8802, exchange='CME'),
                'ratio': 1,
                'quote': {'mark': 1.27},
            },
        ]

        # Without a learned tick, the resolver returns the fine market-rule tick.
        fresh = asyncio.run(
            adapter._resolve_price_increment_for_legs(resolved_legs, 2.53, 'CME', 0.01)
        )
        self.assertEqual(fresh, 0.05)

        # After learning a coarser working tick for this combo shape, reuse it so
        # the next submit skips the reject/retry round-trip.
        adapter.combo_working_increment_by_signature[((8801, 1), (8802, 1))] = 0.25
        reused = asyncio.run(
            adapter._resolve_price_increment_for_legs(resolved_legs, 2.53, 'CME', 0.01)
        )
        self.assertEqual(reused, 0.25)

    def test_contract_details_timeout_uses_fallback_increment(self):
        class _SlowDetailsIb(_DummyIb):
            async def reqContractDetailsAsync(self, _contract):
                await asyncio.sleep(1.0)
                return [SimpleNamespace(
                    minTick=0.25,
                    validExchanges='SMART',
                    marketRuleIds='101',
                    contract=SimpleNamespace(exchange='SMART'),
                )]

        adapter = IbkrExecutionAdapter(
            ib=_SlowDetailsIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
        )
        adapter.tick_size_request_timeout_seconds = 0.01

        result = asyncio.run(adapter._resolve_contract_price_increment(
            SimpleNamespace(conId=9901),
            'SMART',
            65.63,
            0.05,
        ))

        self.assertEqual(result, 0.05)
        self.assertNotIn(9901, adapter.contract_details_cache_by_con_id)

    def test_market_rule_timeout_uses_fallback_increment(self):
        class _SlowMarketRuleIb(_DummyIb):
            async def reqContractDetailsAsync(self, _contract):
                return [SimpleNamespace(
                    minTick=None,
                    validExchanges='SMART',
                    marketRuleIds='101',
                    contract=SimpleNamespace(exchange='SMART'),
                )]

            async def reqMarketRuleAsync(self, _market_rule_id):
                await asyncio.sleep(1.0)
                return [SimpleNamespace(lowEdge=0, increment=0.25)]

        adapter = IbkrExecutionAdapter(
            ib=_SlowMarketRuleIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
        )
        adapter.tick_size_request_timeout_seconds = 0.01

        result = asyncio.run(adapter._resolve_contract_price_increment(
            SimpleNamespace(conId=9902),
            'SMART',
            65.63,
            0.05,
        ))

        self.assertEqual(result, 0.05)
        self.assertNotIn(101, adapter.market_rule_cache_by_id)

    def test_extract_trade_status_message_prefers_latest_non_empty_trade_log_message(self):
        trade = SimpleNamespace(
            log=[
                SimpleNamespace(message='', errorCode=0),
                SimpleNamespace(message='Order rejected - reason', errorCode=201),
                SimpleNamespace(message='', errorCode=0),
            ],
            advancedError='',
        )

        self.assertEqual(
            self.adapter._extract_trade_status_message(trade),
            'IB 201: Order rejected - reason',
        )

    def test_extract_trade_status_message_falls_back_to_advanced_error(self):
        trade = SimpleNamespace(
            log=[SimpleNamespace(message='', errorCode=0)],
            advancedError='Advanced reject detail',
        )

        self.assertEqual(
            self.adapter._extract_trade_status_message(trade),
            'Advanced reject detail',
        )


class IbServerOrderErrorTests(unittest.TestCase):
    def setUp(self):
        self._original_get_snapshot = ib_server.execution_engine.get_managed_order_snapshot
        ib_server.execution_engine.get_managed_order_snapshot = lambda _order_id, _perm_id: None

    def tearDown(self):
        ib_server.execution_engine.get_managed_order_snapshot = self._original_get_snapshot

    def test_record_combo_order_error_formats_html_and_marks_order_inactive(self):
        tracking = {
            'status': 'PendingSubmit',
        }

        message = ib_server._record_combo_order_error(
            tracking,
            201,
            'Order rejected - reason:Available Funds are in sufficient.<br>Initial Margin too high.',
        )

        self.assertEqual(
            message,
            'IB 201: Order rejected - reason:Available Funds are in sufficient. Initial Margin too high.',
        )
        self.assertEqual(tracking['status'], 'Inactive')
        self.assertEqual(tracking['statusMessage'], message)

    def test_build_combo_order_status_payload_uses_tracked_error_message_when_trade_log_is_blank(self):
        tracking = {
            'groupId': 'group_1',
            'groupName': 'Combo Group 2',
            'executionMode': 'submit',
            'executionIntent': 'open',
            'requestSource': 'trial_trigger',
            'orderId': 42567,
            'permId': 429367627,
            'status': 'Inactive',
            'filled': 0.0,
            'remaining': 1.0,
            'statusMessage': 'IB 201: Order rejected - reason: Available Funds are insufficient.',
        }
        trade = SimpleNamespace(
            order=SimpleNamespace(orderId=42567, account='U17775528'),
            orderStatus=SimpleNamespace(
                permId=429367627,
                status='Inactive',
                filled=0.0,
                remaining=1.0,
                avgFillPrice=0.0,
                lastFillPrice=0.0,
                whyHeld='',
                mktCapPrice=0.0,
            ),
            log=[SimpleNamespace(message='', errorCode=0)],
            advancedError='',
        )

        payload = ib_server._build_combo_order_status_payload(trade, tracking)

        self.assertEqual(payload['orderStatus']['status'], 'Inactive')
        self.assertEqual(
            payload['orderStatus']['statusMessage'],
            'IB 201: Order rejected - reason: Available Funds are insufficient.',
        )


class IbServerHedgeOrderTrackingTests(unittest.TestCase):
    def setUp(self):
        ib_server.hedge_order_tracking_by_order_id.clear()
        ib_server.hedge_order_tracking_by_perm_id.clear()

    def tearDown(self):
        ib_server.hedge_order_tracking_by_order_id.clear()
        ib_server.hedge_order_tracking_by_perm_id.clear()

    def _build_request(self):
        return HedgeOrderRequest(
            hedge_id='delta_spy',
            hedge_name='SPY Delta Hedge',
            sec_type='STK',
            symbol='SPY',
            exchange='SMART',
            currency='USD',
            order_action='SELL',
            quantity=4,
            order_type='LMT',
            limit_price=481.25,
            time_in_force='DAY',
            execution_mode='submit',
            account='DU12345',
            request_source='delta_hedge_manual',
            current_net_delta=150.0,
            projected_net_delta=10.0,
            target_lower=-25.0,
            target_upper=25.0,
        )

    def _build_result(self):
        preview = HedgeOrderPreview(
            hedge_id='delta_spy',
            hedge_name='SPY Delta Hedge',
            sec_type='STK',
            symbol='SPY',
            local_symbol='SPY',
            exchange='SMART',
            currency='USD',
            order_action='SELL',
            quantity=4,
            order_type='LMT',
            limit_price=481.25,
            time_in_force='DAY',
            execution_mode='submit',
            account='DU12345',
            request_source='delta_hedge_manual',
            con_id=756733,
            current_net_delta=150.0,
            projected_net_delta=10.0,
            target_lower=-25.0,
            target_upper=25.0,
        )
        return HedgeSubmitResult(
            preview=preview,
            order_id=1001,
            perm_id=2002,
            status='Submitted',
            status_message='Submitted to IB',
        )

    def _record_submission(self, websocket=None):
        websocket = websocket or object()
        request = self._build_request()
        result = self._build_result()
        ib_server._record_hedge_order_submission(websocket, request, result)
        return websocket, request, result

    def test_record_hedge_order_submission_tracks_by_order_and_perm_id(self):
        websocket, request, result = self._record_submission()

        tracking = ib_server.hedge_order_tracking_by_order_id[1001]
        self.assertIs(ib_server.hedge_order_tracking_by_perm_id[2002], tracking)
        self.assertIs(tracking['websocket'], websocket)
        self.assertEqual(tracking['hedgeId'], request.hedge_id)
        self.assertEqual(tracking['hedgeName'], request.hedge_name)
        self.assertEqual(tracking['account'], 'DU12345')
        self.assertEqual(tracking['secType'], 'STK')
        self.assertEqual(tracking['symbol'], 'SPY')
        self.assertEqual(tracking['conId'], 756733)
        self.assertEqual(tracking['orderAction'], 'SELL')
        self.assertEqual(tracking['quantity'], 4)
        self.assertEqual(tracking['limitPrice'], 481.25)
        self.assertEqual(tracking['projectedNetDelta'], 10.0)
        self.assertEqual(tracking['targetLower'], -25.0)
        self.assertEqual(tracking['status'], result.status)
        self.assertEqual(tracking['statusMessage'], result.status_message)
        self.assertEqual(tracking['fillTotals']['filledQuantity'], 0.0)
        self.assertEqual(tracking['seenExecIds'], set())

    def test_build_hedge_order_status_payload_uses_independent_action(self):
        self._record_submission()
        tracking = ib_server.hedge_order_tracking_by_order_id[1001]
        trade = SimpleNamespace(
            order=SimpleNamespace(orderId=1001, account='DU12345'),
            orderStatus=SimpleNamespace(
                permId=2002,
                status='Submitted',
                filled=1.0,
                remaining=3.0,
                avgFillPrice=481.25,
                lastFillPrice=481.25,
                whyHeld='',
                mktCapPrice=0.0,
            ),
            log=[SimpleNamespace(message='', errorCode=0)],
            advancedError='',
        )

        ib_server._update_hedge_order_tracking_snapshot(
            tracking,
            order=trade.order,
            order_status=trade.orderStatus,
            trade=trade,
        )
        payload = ib_server._build_hedge_order_status_payload(trade, tracking)

        self.assertEqual(payload['action'], 'hedge_order_status_update')
        self.assertEqual(payload['hedgeId'], 'delta_spy')
        self.assertEqual(payload['orderStatus']['hedgeId'], 'delta_spy')
        self.assertEqual(payload['orderStatus']['account'], 'DU12345')
        self.assertEqual(payload['orderStatus']['secType'], 'STK')
        self.assertEqual(payload['orderStatus']['symbol'], 'SPY')
        self.assertEqual(payload['orderStatus']['orderAction'], 'SELL')
        self.assertEqual(payload['orderStatus']['quantity'], 4)
        self.assertEqual(payload['orderStatus']['orderId'], 1001)
        self.assertEqual(payload['orderStatus']['permId'], 2002)
        self.assertEqual(payload['orderStatus']['status'], 'Submitted')
        self.assertEqual(payload['orderStatus']['filled'], 1.0)
        self.assertEqual(payload['orderStatus']['remaining'], 3.0)
        self.assertEqual(payload['orderStatus']['projectedNetDelta'], 10.0)

    def test_record_hedge_order_fill_accumulates_and_deduplicates_exec_ids(self):
        self._record_submission()
        tracking = ib_server.hedge_order_tracking_by_order_id[1001]
        execution = SimpleNamespace(
            orderId=1001,
            permId=2002,
            execId='0001.01',
            side='SLD',
            shares=2,
            price=481.5,
        )
        contract = SimpleNamespace(
            conId=756733,
            localSymbol='SPY',
            symbol='SPY',
            secType='STK',
            exchange='SMART',
            currency='USD',
        )

        payload = ib_server._record_hedge_order_fill(tracking, execution, contract)
        duplicate_payload = ib_server._record_hedge_order_fill(tracking, execution, contract)

        self.assertEqual(payload['action'], 'hedge_order_fill_update')
        self.assertEqual(payload['hedgeId'], 'delta_spy')
        self.assertEqual(payload['orderFill']['orderId'], 1001)
        self.assertEqual(payload['orderFill']['permId'], 2002)
        self.assertEqual(payload['orderFill']['executionSide'], 'SLD')
        self.assertEqual(payload['orderFill']['filledQuantity'], 2.0)
        self.assertEqual(payload['orderFill']['avgFillPrice'], 481.5)
        self.assertEqual(payload['orderFill']['lastFillPrice'], 481.5)
        self.assertEqual(payload['orderFill']['executionId'], '0001.01')
        self.assertIsNone(duplicate_payload)
        self.assertEqual(tracking['fillTotals']['filledQuantity'], 2.0)
        self.assertEqual(tracking['fillTotals']['filledNotional'], 963.0)

    def test_purge_hedge_order_tracking_for_websocket_detaches_active_orders(self):
        websocket, _request, _result = self._record_submission()
        other_websocket = object()
        other_request = self._build_request()
        other_result = self._build_result()
        other_result.order_id = 1002
        other_result.perm_id = 2003
        ib_server._record_hedge_order_submission(other_websocket, other_request, other_result)

        ib_server._purge_hedge_order_tracking_for_websocket(websocket)

        self.assertIn(1001, ib_server.hedge_order_tracking_by_order_id)
        self.assertIn(2002, ib_server.hedge_order_tracking_by_perm_id)
        self.assertIsNone(ib_server.hedge_order_tracking_by_order_id[1001]['websocket'])
        self.assertIn(1002, ib_server.hedge_order_tracking_by_order_id)
        self.assertIn(2003, ib_server.hedge_order_tracking_by_perm_id)
        self.assertIs(ib_server.hedge_order_tracking_by_order_id[1002]['websocket'], other_websocket)

    def test_active_hedge_orders_snapshot_reattaches_matching_orders(self):
        old_websocket, _request, _result = self._record_submission()
        ib_server._purge_hedge_order_tracking_for_websocket(old_websocket)
        new_websocket = object()

        payload = ib_server._build_active_hedge_orders_snapshot(new_websocket, {
            'hedgeId': 'delta_spy',
            'account': 'DU12345',
        })

        self.assertEqual(payload['action'], 'active_hedge_orders_snapshot')
        self.assertEqual(len(payload['orders']), 1)
        self.assertEqual(payload['orders'][0]['hedgeId'], 'delta_spy')
        self.assertEqual(payload['orders'][0]['orderId'], 1001)
        self.assertIs(ib_server.hedge_order_tracking_by_order_id[1001]['websocket'], new_websocket)

    def test_detached_hedge_tracking_still_records_status_and_fills(self):
        old_websocket, _request, _result = self._record_submission()
        ib_server._purge_hedge_order_tracking_for_websocket(old_websocket)
        tracking = ib_server.hedge_order_tracking_by_order_id[1001]

        trade = SimpleNamespace(
            order=SimpleNamespace(orderId=1001, account='DU12345'),
            orderStatus=SimpleNamespace(
                permId=2002,
                status='Submitted',
                filled=1.0,
                remaining=3.0,
                avgFillPrice=481.25,
                lastFillPrice=481.25,
                whyHeld='',
                mktCapPrice=0.0,
            ),
            contract=SimpleNamespace(secType='STK', conId=756733, localSymbol='SPY', symbol='SPY'),
            log=[],
            advancedError='',
        )
        fill = SimpleNamespace(
            contract=trade.contract,
            execution=SimpleNamespace(
                orderId=1001,
                permId=2002,
                execId='detached.1',
                side='SLD',
                shares=1,
                price=481.25,
            ),
        )

        ib_server.on_hedge_order_status(trade)
        ib_server.on_hedge_order_exec_details(trade, fill)

        self.assertEqual(tracking['status'], 'Submitted')
        self.assertEqual(tracking['filled'], 1.0)
        self.assertEqual(tracking['remaining'], 3.0)
        self.assertEqual(tracking['fillTotals']['filledQuantity'], 1.0)


class IbServerIvTermStructureTests(unittest.TestCase):
    def test_secdef_exchange_is_blank_for_equity_and_etf_option_chains(self):
        exchange = ib_server._resolve_iv_term_structure_secdef_exchange(
            {
                'secType': 'OPT',
                'symbol': 'SPY',
                'exchange': 'SMART',
            },
            {
                'secType': 'STK',
                'symbol': 'SPY',
                'exchange': 'SMART',
            },
        )

        self.assertEqual(exchange, '')

    def test_secdef_exchange_uses_contract_exchange_for_futures_option_chains(self):
        exchange = ib_server._resolve_iv_term_structure_secdef_exchange(
            {
                'secType': 'FOP',
                'symbol': 'ES',
                'exchange': 'CME',
            },
            {
                'secType': 'FUT',
                'symbol': 'ES',
                'exchange': 'CME',
            },
        )

        self.assertEqual(exchange, 'CME')


class IbServerMicroFamilyDefaultsTests(unittest.TestCase):
    def test_supported_live_families_include_micro_equity_index_futures_options(self):
        self.assertEqual(ib_server.SUPPORTED_LIVE_FAMILIES['MES']['underlying_sec_type'], 'FUT')
        self.assertEqual(ib_server.SUPPORTED_LIVE_FAMILIES['MES']['option_sec_type'], 'FOP')
        self.assertEqual(ib_server.SUPPORTED_LIVE_FAMILIES['MES']['underlying_symbol'], 'MES')
        self.assertEqual(ib_server.SUPPORTED_LIVE_FAMILIES['MES']['option_symbol'], 'MES')
        self.assertEqual(ib_server.SUPPORTED_LIVE_FAMILIES['MES']['exchange'], 'CME')
        self.assertEqual(ib_server.SUPPORTED_LIVE_FAMILIES['MES']['multiplier'], '5')
        self.assertNotIn('trading_class', ib_server.SUPPORTED_LIVE_FAMILIES['MES'])

        self.assertEqual(ib_server.SUPPORTED_LIVE_FAMILIES['MNQ']['underlying_sec_type'], 'FUT')
        self.assertEqual(ib_server.SUPPORTED_LIVE_FAMILIES['MNQ']['option_sec_type'], 'FOP')
        self.assertEqual(ib_server.SUPPORTED_LIVE_FAMILIES['MNQ']['underlying_symbol'], 'MNQ')
        self.assertEqual(ib_server.SUPPORTED_LIVE_FAMILIES['MNQ']['option_symbol'], 'MNQ')
        self.assertEqual(ib_server.SUPPORTED_LIVE_FAMILIES['MNQ']['exchange'], 'CME')
        self.assertEqual(ib_server.SUPPORTED_LIVE_FAMILIES['MNQ']['multiplier'], '2')
        self.assertNotIn('trading_class', ib_server.SUPPORTED_LIVE_FAMILIES['MNQ'])

    def test_build_underlying_request_uses_micro_family_multipliers(self):
        mes_request = ib_server._build_underlying_request('MES', [{'contractMonth': '202606'}])
        self.assertEqual(mes_request['secType'], 'FUT')
        self.assertEqual(mes_request['symbol'], 'MES')
        self.assertEqual(mes_request['exchange'], 'CME')
        self.assertEqual(mes_request['multiplier'], '5')
        self.assertEqual(mes_request['contractMonth'], '202606')

        mnq_request = ib_server._build_underlying_request('MNQ', [{'expDate': '20260918'}])
        self.assertEqual(mnq_request['secType'], 'FUT')
        self.assertEqual(mnq_request['symbol'], 'MNQ')
        self.assertEqual(mnq_request['exchange'], 'CME')
        self.assertEqual(mnq_request['multiplier'], '2')
        self.assertEqual(mnq_request['contractMonth'], '202609')


class IbServerExecutionDispatchTests(unittest.TestCase):
    def setUp(self):
        self._original_execution_engine = ib_server.execution_engine

    def tearDown(self):
        ib_server.execution_engine = self._original_execution_engine

    def test_dispatch_routes_hedge_actions_before_combo_actions(self):
        class _ExecutionEngineStub:
            def __init__(self):
                self.calls = []

            async def handle_hedge_action(self, websocket, data, client_ip='Unknown'):
                self.calls.append(('hedge', websocket, data, client_ip))
                return {
                    'action': 'hedge_order_preview_result',
                    'hedgeId': data.get('hedgeId'),
                }

            async def handle_combo_action(self, websocket, data, client_ip='Unknown'):
                self.calls.append(('combo', websocket, data, client_ip))
                return {
                    'action': 'combo_order_preview_result',
                    'groupId': data.get('groupId'),
                }

        stub = _ExecutionEngineStub()
        ib_server.execution_engine = stub
        payload = asyncio.run(ib_server._dispatch_execution_action(
            None,
            {
                'action': 'preview_hedge_order',
                'hedgeId': 'delta_spy',
            },
            client_ip='127.0.0.1',
        ))

        self.assertEqual(payload['action'], 'hedge_order_preview_result')
        self.assertEqual(payload['hedgeId'], 'delta_spy')
        self.assertEqual([call[0] for call in stub.calls], ['hedge'])

    def test_dispatch_preserves_combo_action_fallback(self):
        class _ExecutionEngineStub:
            def __init__(self):
                self.calls = []

            async def handle_hedge_action(self, websocket, data, client_ip='Unknown'):
                self.calls.append(('hedge', websocket, data, client_ip))
                return None

            async def handle_combo_action(self, websocket, data, client_ip='Unknown'):
                self.calls.append(('combo', websocket, data, client_ip))
                return {
                    'action': 'combo_order_preview_result',
                    'groupId': data.get('groupId'),
                }

        stub = _ExecutionEngineStub()
        ib_server.execution_engine = stub
        payload = asyncio.run(ib_server._dispatch_execution_action(
            None,
            {
                'action': 'preview_combo_order',
                'groupId': 'group_1',
            },
            client_ip='127.0.0.1',
        ))

        self.assertEqual(payload['action'], 'combo_order_preview_result')
        self.assertEqual(payload['groupId'], 'group_1')
        self.assertEqual([call[0] for call in stub.calls], ['hedge', 'combo'])


class IbkrAdapterSubmitPreRegistrationTests(unittest.IsolatedAsyncioTestCase):
    def _build_close_leg(self, leg_id, pos, right, strike=415, exp_date='20260618'):
        return ComboLegRequest.from_payload({
            'id': leg_id,
            'type': 'put' if right == 'P' else 'call',
            'pos': pos,
            'secType': 'OPT',
            'symbol': 'GLD',
            'underlyingSymbol': 'GLD',
            'exchange': 'SMART',
            'underlyingExchange': 'SMART',
            'currency': 'USD',
            'multiplier': '100',
            'underlyingMultiplier': '100',
            'right': right,
            'strike': strike,
            'expDate': exp_date,
            'contractMonth': exp_date[:6],
        })

    def test_assignment_aware_close_plan_replaces_missing_short_put_with_underlying_close(self):
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            portfolio_positions_provider=lambda: [
                {'account': 'U1', 'secType': 'OPT', 'symbol': 'GLD', 'expDate': '20260618', 'right': 'C', 'strike': 415, 'position': -16},
                {'account': 'U1', 'secType': 'OPT', 'symbol': 'GLD', 'expDate': '20260717', 'right': 'C', 'strike': 415, 'position': 22},
                {'account': 'U1', 'secType': 'OPT', 'symbol': 'GLD', 'expDate': '20260717', 'right': 'P', 'strike': 415, 'position': 24},
                {'account': 'U1', 'secType': 'STK', 'symbol': 'GLD', 'position': 1600},
            ],
        )
        request = ComboOrderRequest(
            group_id='group_gld',
            group_name='GLD Assignment Close',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            legs=[
                self._build_close_leg('short_call', 16, 'C'),
                self._build_close_leg('assigned_put', 16, 'P'),
                self._build_close_leg('long_call', -22, 'C', exp_date='20260717'),
                self._build_close_leg('long_put', -24, 'P', exp_date='20260717'),
            ],
        )

        plan = adapter._build_assignment_aware_close_plan(request)

        self.assertEqual([leg.id for leg in plan['optionRequest'].legs], ['short_call', 'long_call', 'long_put'])
        self.assertEqual(plan['underlyingLegs'][0].sec_type, 'STK')
        self.assertEqual(plan['underlyingLegs'][0].symbol, 'GLD')
        self.assertEqual(plan['underlyingLegs'][0].pos, -1600)
        adjustment = plan['assignmentAdjustments'][0]
        self.assertEqual(adjustment['optionLegId'], 'assigned_put')
        self.assertEqual(adjustment['assignedOptionPosition'], -16)
        self.assertEqual(adjustment['remainingOptionPosition'], 0)
        self.assertEqual(adjustment['underlyingQuantity'], 1600)
        self.assertEqual(adjustment['underlyingClosePosition'], -1600)

    def test_assignment_aware_close_plan_keeps_remaining_partially_assigned_option_leg(self):
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            portfolio_positions_provider=lambda: [
                {'account': 'U1', 'secType': 'OPT', 'symbol': 'GLD', 'expDate': '20260618', 'right': 'P', 'strike': 415, 'position': -6},
                {'account': 'U1', 'secType': 'STK', 'symbol': 'GLD', 'position': 1000},
            ],
        )
        request = ComboOrderRequest(
            group_id='group_gld_partial',
            group_name='GLD Partial Assignment Close',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            legs=[self._build_close_leg('partial_put', 16, 'P')],
        )

        plan = adapter._build_assignment_aware_close_plan(request)

        self.assertEqual(len(plan['optionRequest'].legs), 1)
        self.assertEqual(plan['optionRequest'].legs[0].id, 'partial_put')
        self.assertEqual(plan['optionRequest'].legs[0].pos, 6)
        self.assertEqual(plan['underlyingLegs'][0].pos, -1000)
        adjustment = plan['assignmentAdjustments'][0]
        self.assertEqual(adjustment['assignedOptionPosition'], -10)
        self.assertEqual(adjustment['remainingOptionPosition'], -6)
        self.assertEqual(adjustment['underlyingQuantity'], 1000)

    def test_assignment_aware_close_plan_clamps_merged_futures_underlying_demands(self):
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            portfolio_positions_provider=lambda: [
                {'account': 'U1', 'secType': 'FUT', 'symbol': 'ES', 'expDate': '202606', 'multiplier': '5', 'position': -2},
            ],
        )
        assigned_fop = ComboLegRequest.from_payload({
            'id': 'assigned_fop_call',
            'type': 'call',
            'pos': 2,
            'secType': 'FOP',
            'symbol': 'ES',
            'underlyingSymbol': 'ES',
            'exchange': 'CME',
            'underlyingExchange': 'CME',
            'currency': 'USD',
            'multiplier': '50',
            'underlyingMultiplier': '5',
            'right': 'C',
            'strike': 5000,
            'expDate': '20260619',
            'contractMonth': '202606',
            'underlyingContractMonth': '202606',
        })
        explicit_future = ComboLegRequest.from_payload({
            'id': 'explicit_future',
            'type': 'future',
            'pos': 2,
            'secType': 'FUT',
            'symbol': 'ES',
            'exchange': 'GLOBEX',
            'currency': 'USD',
            'multiplier': '5.0',
            'contractMonth': '202606',
        })
        request = ComboOrderRequest(
            group_id='group_es_assignment',
            group_name='ES Assignment Close',
            underlying_symbol='ES',
            underlying_contract_month='202606',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            legs=[assigned_fop, explicit_future],
        )

        plan = adapter._build_assignment_aware_close_plan(request)

        self.assertEqual(sum(leg.pos for leg in plan['underlyingLegs']), 2)
        self.assertEqual(len(plan['underlyingLegs']), 1)
        self.assertEqual(plan['underlyingLegs'][0].sec_type, 'FUT')
        self.assertEqual(plan['assignmentAdjustments'][0]['underlyingClosePosition'], 2)
        self.assertTrue(any('Only 2 of 4 requested FUT ES' in message for message in plan['messages']))

    def test_assignment_close_plan_preserves_deliverable_when_underlying_nets_flat(self):
        # Short put assigned, but the deliverable underlying already nets flat in TWS (position 0),
        # so no underlying close order is produced. The deliverable must still be reported so the
        # client can book the option->underlying conversion instead of leaving a phantom open leg.
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            portfolio_positions_provider=lambda: [
                {'account': 'U1', 'secType': 'STK', 'symbol': 'GLD', 'position': 0},
                {'account': 'U1', 'secType': 'OPT', 'symbol': 'GLD', 'expDate': '20260717', 'right': 'C', 'strike': 415, 'position': 5},
            ],
        )
        request = ComboOrderRequest(
            group_id='group_gld_netted',
            group_name='GLD Netted Assignment Close',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            legs=[self._build_close_leg('assigned_put', 16, 'P')],
        )

        plan = adapter._build_assignment_aware_close_plan(request)

        self.assertEqual(plan['optionRequest'].legs, [])
        self.assertEqual(plan['underlyingLegs'], [])
        adjustment = plan['assignmentAdjustments'][0]
        self.assertEqual(adjustment['assignedOptionPosition'], -16)
        self.assertEqual(adjustment['deliverableUnderlyingPosition'], 1600)
        self.assertEqual(adjustment['underlyingClosePosition'], 0)
        self.assertEqual(adjustment['underlyingQuantity'], 0)

    def test_test_submit_underlying_first_order_uses_guardrail_price(self):
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
        )
        request = ComboOrderRequest(
            group_id='group_test_underlying',
            group_name='Test Underlying',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='test_submit',
            execution_intent='close',
            request_source='close_group',
        )
        leg = ComboLegRequest.from_payload({
            'id': 'stock_leg',
            'type': 'stock',
            'pos': -1600,
            'secType': 'STK',
            'symbol': 'GLD',
            'exchange': 'SMART',
            'currency': 'USD',
        })

        order = adapter._build_underlying_close_order(
            request,
            leg,
            {'bid': 413.2, 'ask': 413.3, 'mark': 413.25},
        )

        self.assertEqual(order.action, 'SELL')
        self.assertGreater(order.lmtPrice, 413.25)

    async def test_preview_assignment_close_shows_underlying_stage_without_assigned_option(self):
        resolved_leg_ids = []
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            portfolio_positions_provider=lambda: [
                {'account': 'U1', 'secType': 'STK', 'symbol': 'GLD', 'position': 1600},
            ],
        )

        async def fake_resolve(_websocket, leg_request):
            resolved_leg_ids.append(leg_request.id)
            self.assertEqual(leg_request.sec_type, 'STK')
            return (
                SimpleNamespace(conId=7101, secType='STK', symbol='GLD', localSymbol='GLD', exchange='SMART'),
                {'bid': 413.2, 'ask': 413.3, 'mark': 413.25},
            )

        adapter._resolve_leg_contract_and_mark = fake_resolve
        request = ComboOrderRequest(
            group_id='group_preview_assignment',
            group_name='GLD Preview Assignment',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='preview',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            legs=[self._build_close_leg('assigned_put', 16, 'P')],
        )

        preview = await adapter.preview_combo_order(object(), request)

        self.assertEqual(resolved_leg_ids, ['__assigned_underlying_assigned_put'])
        self.assertEqual(preview.request_source, 'close_group_underlying')
        self.assertEqual(preview.close_plan_stage, 'underlying')
        self.assertEqual(preview.close_plan_complete, False)
        self.assertEqual(preview.legs[0].sec_type, 'STK')
        self.assertEqual(preview.assignment_adjustments[0]['optionLegId'], 'assigned_put')
        self.assertIn('account-level TWS portfolio positions', preview.pricing_note)

    async def test_validate_assignment_close_excludes_assigned_option_leg(self):
        validated_leg_ids = []
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            portfolio_positions_provider=lambda: [
                {'account': 'U1', 'secType': 'OPT', 'symbol': 'GLD', 'expDate': '20260618', 'right': 'C', 'strike': 415, 'position': -16},
                {'account': 'U1', 'secType': 'STK', 'symbol': 'GLD', 'position': 1600},
            ],
        )

        async def fake_validate(leg_request):
            validated_leg_ids.append(leg_request.id)
            return SimpleNamespace(
                conId=7200 + len(validated_leg_ids),
                secType=leg_request.sec_type,
                symbol=leg_request.symbol,
                localSymbol=leg_request.symbol,
            )

        adapter._validate_leg_contract = fake_validate
        request = ComboOrderRequest(
            group_id='group_validate_assignment',
            group_name='GLD Validate Assignment',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            legs=[
                self._build_close_leg('short_call', 16, 'C'),
                self._build_close_leg('assigned_put', 16, 'P'),
            ],
        )

        result = await adapter.validate_combo_order(object(), request)

        self.assertTrue(result.valid)
        self.assertEqual(validated_leg_ids, ['__assigned_underlying_assigned_put', 'short_call'])

    async def test_submit_closes_assignment_underlying_before_remaining_options(self):
        events = []
        placed_orders = []
        preregistered_sources = []
        resolved_leg_ids = []

        class _SubmitIb:
            def __init__(self):
                self.orderStatusEvent = _DummyEvent()

            def placeOrder(self, contract, order):
                order_index = len(placed_orders)
                order.orderId = 5100 + order_index
                status = 'Filled' if order_index == 0 else 'Submitted'
                avg_fill = 413.2 if order_index == 0 else 0
                trade = SimpleNamespace(
                    order=order,
                    contract=contract,
                    orderStatus=SimpleNamespace(
                        permId=6100 + order_index,
                        status=status,
                        filled=getattr(order, 'totalQuantity', 0) if status == 'Filled' else 0,
                        remaining=0 if status == 'Filled' else getattr(order, 'totalQuantity', 0),
                        avgFillPrice=avg_fill,
                        lastFillPrice=avg_fill,
                        whyHeld='',
                        mktCapPrice=0,
                    ),
                    fills=[],
                    log=[],
                    advancedError='',
                )
                placed_orders.append((contract, order, trade))
                events.append(f"place:{getattr(contract, 'secType', '')}:{getattr(order, 'action', '')}")
                return trade

        def on_combo_order_placed(_websocket, placed_request, _trade, _tracking_legs):
            preregistered_sources.append(placed_request.request_source)
            events.append(f"register:{placed_request.request_source}")
            return None

        adapter = IbkrExecutionAdapter(
            ib=_SubmitIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            on_combo_order_placed=on_combo_order_placed,
            portfolio_positions_provider=lambda: [
                {'account': 'U1', 'secType': 'OPT', 'symbol': 'GLD', 'expDate': '20260618', 'right': 'C', 'strike': 415, 'position': -16},
                {'account': 'U1', 'secType': 'STK', 'symbol': 'GLD', 'position': 1600},
            ],
        )
        adapter._register_managed_context = lambda *args, **kwargs: None

        async def fake_resolve_contract(_websocket, leg_request):
            resolved_leg_ids.append(leg_request.id)
            if leg_request.sec_type == 'STK':
                self.assertEqual(leg_request.symbol, 'GLD')
                self.assertEqual(leg_request.pos, -1600)
                return (
                    SimpleNamespace(conId=7001, secType='STK', symbol='GLD', localSymbol='GLD', exchange='SMART'),
                    {'bid': 413.2, 'ask': 413.3, 'mark': 413.25},
                )
            self.assertEqual(leg_request.sec_type, 'OPT')
            self.assertEqual(leg_request.id, 'short_call')
            self.assertEqual(leg_request.pos, 16)
            return (
                SimpleNamespace(
                    conId=7002,
                    secType='OPT',
                    symbol='GLD',
                    localSymbol='GLD  260618C00415000',
                    exchange='SMART',
                    currency='USD',
                    right='C',
                    strike=415.0,
                ),
                {'bid': 2.0, 'ask': 2.2, 'mark': 2.1},
            )

        adapter._resolve_leg_contract_and_mark = fake_resolve_contract

        request = ComboOrderRequest(
            group_id='group_assignment_submit',
            group_name='GLD Assignment Submit',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            legs=[
                self._build_close_leg('short_call', 16, 'C'),
                self._build_close_leg('assigned_put', 16, 'P'),
            ],
        )

        real_sleep = asyncio.sleep

        async def fake_sleep(seconds):
            events.append(f"sleep:{seconds}")
            await real_sleep(0)

        asyncio.sleep = fake_sleep
        try:
            result = await adapter.submit_combo_order(object(), request)
        finally:
            asyncio.sleep = real_sleep

        self.assertEqual(
            events,
            [
                'place:STK:SELL',
                'register:close_group_underlying',
                'sleep:3.0',
                'place:OPT:BUY',
                'register:close_group',
                'sleep:0.25',
                'sleep:1.25',
            ],
        )
        self.assertEqual(preregistered_sources, ['close_group_underlying', 'close_group'])
        self.assertEqual(resolved_leg_ids, ['__assigned_underlying_assigned_put', 'short_call'])
        self.assertEqual(placed_orders[1][0].secType, 'OPT')
        self.assertEqual(placed_orders[1][1].totalQuantity, 16)
        self.assertEqual(result.order_id, 5101)
        self.assertEqual(result.status, 'Submitted')
        self.assertEqual(result.preview.close_plan_stage, 'options')
        self.assertEqual(result.preview.close_plan_complete, None)
        self.assertIn('regular order instead of BAG', result.preview.pricing_note)
        self.assertIn('account-level TWS portfolio positions', result.preview.close_plan_message)
        self.assertEqual(result.preview.staged_orders[0]['orderId'], 5100)
        self.assertEqual(result.preview.staged_orders[0]['orderAction'], 'SELL')
        self.assertEqual(result.preview.assignment_adjustments[0]['optionLegId'], 'assigned_put')
        self.assertEqual(result.preview.assignment_adjustments[0]['underlyingAvgFillPrice'], 413.2)

    async def test_pre_registers_combo_tracking_before_settle_sleep(self):
        events = []

        class _SubmitIb:
            def __init__(self):
                self.orderStatusEvent = _DummyEvent()

            def placeOrder(self, contract, order):
                events.append('place_order')
                order.orderId = 4500
                return SimpleNamespace(
                    order=order,
                    orderStatus=SimpleNamespace(
                        permId=4501,
                        status='PendingSubmit',
                        filled=0,
                        remaining=1,
                        avgFillPrice=0,
                        lastFillPrice=0,
                        whyHeld='',
                        mktCapPrice=0,
                    ),
                    log=[],
                    advancedError='',
                )

        def on_combo_order_placed(websocket, request, trade, tracking_legs):
            events.append('pre_register')
            self.assertEqual(getattr(trade.order, 'orderId', None), 4500)
            self.assertEqual(len(tracking_legs), 1)
            self.assertEqual(tracking_legs[0]['id'], 'leg_1')
            self.assertEqual(tracking_legs[0]['conId'], 12345)

        adapter = IbkrExecutionAdapter(
            ib=_SubmitIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            on_combo_order_placed=on_combo_order_placed,
        )
        adapter._register_managed_context = lambda *args, **kwargs: None

        preview = ComboOrderPreview(
            group_id='group_pre_reg',
            group_name='Pre Registration',
            combo_symbol='SPY',
            combo_exchange='SMART',
            order_action='BUY',
            total_quantity=1,
            limit_price=1.25,
            pricing_source='middle',
            raw_net_mid=1.25,
            execution_mode='submit',
        )
        order = SimpleNamespace(
            action='BUY',
            orderType='LMT',
            totalQuantity=1,
            lmtPrice=1.25,
            tif='DAY',
            transmit=True,
        )
        resolved_legs = [{
            'request': SimpleNamespace(id='leg_1', exp_date='2026-06-19'),
            'contract': SimpleNamespace(
                conId=12345,
                localSymbol='SPY  260619C00500000',
                symbol='SPY',
                secType='OPT',
                right='C',
                strike=500.0,
            ),
            'pos': 1,
            'ratio': 1,
            'quote': {'bid': 1.2, 'ask': 1.3, 'mark': 1.25},
        }]

        async def fake_build(websocket, request):
            return {
                'comboContract': SimpleNamespace(secType='BAG'),
                'order': order,
                'preview': preview,
                'resolvedLegs': resolved_legs,
            }

        adapter._build_combo_order_from_request = fake_build

        request = ComboOrderRequest(
            group_id='group_pre_reg',
            group_name='Pre Registration',
            underlying_symbol='SPY',
            underlying_contract_month='',
            execution_mode='submit',
        )

        real_sleep = asyncio.sleep

        async def fake_sleep(_seconds):
            events.append('sleep')
            await real_sleep(0)

        asyncio.sleep = fake_sleep
        try:
            result = await adapter.submit_combo_order(object(), request)
        finally:
            asyncio.sleep = real_sleep

        # Pre-registration still happens before any settle sleep; the settle now
        # runs as a short reject-probe followed by the remaining window (two sleeps).
        self.assertEqual(events, ['place_order', 'pre_register', 'sleep', 'sleep'])
        self.assertEqual(result.order_id, 4500)
        self.assertEqual(result.perm_id, 4501)
        self.assertIs(result.trade.order, order)

    async def test_submit_result_uses_error_message_captured_during_pre_registration(self):
        captured_tracking = {
            'status': 'Inactive',
            'statusMessage': 'IB 201: Order rejected - reason: Available Funds are insufficient.',
        }

        class _SubmitIb:
            def __init__(self):
                self.orderStatusEvent = _DummyEvent()

            def placeOrder(self, contract, order):
                order.orderId = 4600
                return SimpleNamespace(
                    order=order,
                    orderStatus=SimpleNamespace(
                        permId=4601,
                        status='PendingSubmit',
                        filled=0,
                        remaining=1,
                        avgFillPrice=0,
                        lastFillPrice=0,
                        whyHeld='',
                        mktCapPrice=0,
                    ),
                    log=[],
                    advancedError='',
                )

        def on_combo_order_placed(_websocket, _request, _trade, _tracking_legs):
            return captured_tracking

        adapter = IbkrExecutionAdapter(
            ib=_SubmitIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            on_combo_order_placed=on_combo_order_placed,
        )
        adapter._register_managed_context = lambda *args, **kwargs: None

        preview = ComboOrderPreview(
            group_id='group_rejected',
            group_name='Rejected Combo',
            combo_symbol='SPY',
            combo_exchange='SMART',
            order_action='BUY',
            total_quantity=1,
            limit_price=1.25,
            pricing_source='middle',
            raw_net_mid=1.25,
            execution_mode='submit',
        )
        order = SimpleNamespace(
            action='BUY',
            orderType='LMT',
            totalQuantity=1,
            lmtPrice=1.25,
            tif='DAY',
            transmit=True,
        )
        resolved_legs = [{
            'request': SimpleNamespace(id='leg_1', exp_date='2026-06-19'),
            'contract': SimpleNamespace(
                conId=12345,
                localSymbol='SPY  260619C00500000',
                symbol='SPY',
                secType='OPT',
                right='C',
                strike=500.0,
            ),
            'pos': 1,
            'ratio': 1,
            'quote': {'bid': 1.2, 'ask': 1.3, 'mark': 1.25},
        }]

        async def fake_build(_websocket, _request):
            return {
                'comboContract': SimpleNamespace(secType='BAG'),
                'order': order,
                'preview': preview,
                'resolvedLegs': resolved_legs,
            }

        adapter._build_combo_order_from_request = fake_build

        request = ComboOrderRequest(
            group_id='group_rejected',
            group_name='Rejected Combo',
            underlying_symbol='SPY',
            underlying_contract_month='',
            execution_mode='submit',
        )

        real_sleep = asyncio.sleep

        async def fake_sleep(_seconds):
            await real_sleep(0)

        asyncio.sleep = fake_sleep
        try:
            result = await adapter.submit_combo_order(object(), request)
        finally:
            asyncio.sleep = real_sleep

        self.assertEqual(result.status, 'Inactive')
        self.assertEqual(
            result.status_message,
            'IB 201: Order rejected - reason: Available Funds are insufficient.',
        )
        self.assertEqual(result.to_payload()['statusMessage'], result.status_message)

    async def test_retries_combo_submit_with_coarser_tick_after_min_price_reject(self):
        placed_orders = []
        managed_order_ids = []

        class _SubmitIb:
            def __init__(self):
                self.orderStatusEvent = _DummyEvent()

            def placeOrder(self, contract, order):
                order_index = len(placed_orders)
                order.orderId = 4700 + order_index
                status = 'Inactive' if order_index == 0 else 'Submitted'
                log = []
                if order_index == 0:
                    log = [SimpleNamespace(
                        errorCode=110,
                        message='Error 110, reqId 387: The price does not conform to the minimum price variation for this contract.',
                    )]
                trade = SimpleNamespace(
                    order=order,
                    contract=contract,
                    orderStatus=SimpleNamespace(
                        permId=5700 + order_index,
                        status=status,
                        filled=0,
                        remaining=getattr(order, 'totalQuantity', 0),
                        avgFillPrice=0,
                        lastFillPrice=0,
                        whyHeld='',
                        mktCapPrice=0,
                    ),
                    fills=[],
                    log=log,
                    advancedError='',
                )
                placed_orders.append((contract, order, trade))
                return trade

        adapter = IbkrExecutionAdapter(
            ib=_SubmitIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
        )

        def fake_register(_websocket, _request, _combo_contract, trade, _preview, _resolved_legs):
            managed_order_ids.append(getattr(getattr(trade, 'order', None), 'orderId', None))
            return None

        adapter._register_managed_context = fake_register

        preview = ComboOrderPreview(
            group_id='group_tick_retry',
            group_name='Tick Retry',
            combo_symbol='MES',
            combo_exchange='CME',
            order_action='BUY',
            total_quantity=1,
            limit_price=2.55,
            pricing_source='middle',
            raw_net_mid=2.58,
            execution_mode='submit',
        )
        preview.price_increment = 0.05
        order = SimpleNamespace(
            action='BUY',
            orderType='LMT',
            totalQuantity=1,
            lmtPrice=2.55,
            tif='DAY',
            transmit=True,
        )
        resolved_legs = [
            {
                'request': SimpleNamespace(id='leg_1', exp_date='2026-06-19'),
                'contract': SimpleNamespace(
                    conId=12345,
                    localSymbol='MES  260619C07560000',
                    symbol='MES',
                    secType='FOP',
                    right='C',
                    strike=7560.0,
                ),
                'pos': 1,
                'ratio': 1,
                'quote': {'bid': 2.5, 'ask': 2.65, 'mark': 2.58},
            },
            {
                'request': SimpleNamespace(id='leg_2', exp_date='2026-06-19'),
                'contract': SimpleNamespace(
                    conId=12346,
                    localSymbol='MES  260619P07560000',
                    symbol='MES',
                    secType='FOP',
                    right='P',
                    strike=7560.0,
                ),
                'pos': -1,
                'ratio': 1,
                'quote': {'bid': 2.4, 'ask': 2.55, 'mark': 2.48},
            },
        ]

        async def fake_build(_websocket, _request):
            return {
                'comboContract': SimpleNamespace(secType='BAG', exchange='CME'),
                'order': order,
                'preview': preview,
                'resolvedLegs': resolved_legs,
                'priceIncrement': 0.05,
                'rawLimitPrice': 2.58,
            }

        adapter._build_combo_order_from_request = fake_build

        request = ComboOrderRequest(
            group_id='group_tick_retry',
            group_name='Tick Retry',
            underlying_symbol='MES',
            underlying_contract_month='202609',
            execution_mode='submit',
        )

        real_sleep = asyncio.sleep
        sleep_calls = []

        async def fake_sleep(seconds):
            sleep_calls.append(seconds)
            await real_sleep(0)

        asyncio.sleep = fake_sleep
        try:
            result = await adapter.submit_combo_order(object(), request)
        finally:
            asyncio.sleep = real_sleep

        self.assertEqual(len(placed_orders), 2)
        # First attempt bails out after the short reject probe (110 detected);
        # the accepted retry waits the probe plus the remaining settle window.
        self.assertEqual(sleep_calls, [0.25, 0.25, 1.25])
        # The coarser tick that TWS accepted is remembered for this combo shape.
        self.assertEqual(
            adapter.combo_working_increment_by_signature.get(((12345, 1), (12346, 1))),
            0.25,
        )
        self.assertEqual(placed_orders[0][1].lmtPrice, 2.55)
        self.assertEqual(placed_orders[1][1].lmtPrice, 2.5)
        self.assertEqual(result.order_id, 4701)
        self.assertEqual(result.status, 'Submitted')
        self.assertIsNone(result.status_message)
        self.assertEqual(managed_order_ids, [4701])
        self.assertEqual(result.preview.limit_price, 2.5)
        self.assertEqual(result.preview.price_increment, 0.25)
        self.assertEqual(result.to_payload()['priceIncrement'], 0.25)
        self.assertIn('minimum price variation', result.preview.pricing_note)
        self.assertIn('resubmitted at 2.5', result.preview.pricing_note)
        self.assertEqual(len(result.preview.staged_orders), 2)
        self.assertEqual(result.preview.staged_orders[0]['status'], 'Inactive')
        self.assertEqual(result.preview.staged_orders[0]['priceIncrement'], 0.05)
        self.assertEqual(result.preview.staged_orders[1]['status'], 'Submitted')
        self.assertEqual(result.preview.staged_orders[1]['priceIncrement'], 0.25)

    async def test_cancel_reprice_task_and_wait_awaits_termination(self):
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
        )
        started = asyncio.Event()
        observed_cancel = {'value': False}

        async def fake_loop():
            started.set()
            try:
                await asyncio.sleep(100)
            except asyncio.CancelledError:
                observed_cancel['value'] = True
                raise

        task = asyncio.create_task(fake_loop())
        await started.wait()
        context = {'task': task, 'groupId': 'g_cancel_wait'}

        await adapter._cancel_reprice_task_and_wait(context)

        # The helper must await the loop to full termination, not fire-and-forget,
        # so a restart/cancel path can never overlap a doomed loop with a new one.
        self.assertTrue(task.done())
        self.assertTrue(observed_cancel['value'])

    async def test_cancel_reprice_task_and_wait_skips_current_task(self):
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
        )
        # Invoked from within the loop task itself, awaiting self would hang;
        # the helper must no-op (and never cancel the caller) instead.
        context = {'task': asyncio.current_task(), 'groupId': 'g_self'}
        await asyncio.wait_for(adapter._cancel_reprice_task_and_wait(context), timeout=1.0)
        self.assertFalse(asyncio.current_task().cancelled())


class IbkrAdapterManagedAdoptionTests(unittest.TestCase):
    def _build_adapter(self):
        return IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
        )

    def test_adopt_managed_combo_order_claims_only_orphaned_contexts(self):
        adapter = self._build_adapter()
        new_websocket = object()
        orphan_context = {'websocket': None, 'orderId': 5100, 'permId': 5101}
        adapter.managed_executions_by_order_id[5100] = orphan_context
        adapter.managed_executions_by_perm_id[5101] = orphan_context

        self.assertTrue(adapter.adopt_managed_combo_order(new_websocket, 5100, 5101))
        self.assertIs(orphan_context['websocket'], new_websocket)
        self.assertIsNone(orphan_context['lastManagedEmitSignature'])

    def test_adopt_managed_combo_order_leaves_live_sessions_untouched(self):
        adapter = self._build_adapter()
        owner_websocket = object()
        other_websocket = object()
        owned_context = {'websocket': owner_websocket, 'orderId': 5200, 'permId': 5201}
        adapter.managed_executions_by_order_id[5200] = owned_context
        adapter.managed_executions_by_perm_id[5201] = owned_context

        self.assertFalse(adapter.adopt_managed_combo_order(other_websocket, 5200, 5201))
        self.assertIs(owned_context['websocket'], owner_websocket)
        self.assertFalse(adapter.adopt_managed_combo_order(other_websocket, 9999, None))


class IbServerSubmissionFillReplayTests(unittest.IsolatedAsyncioTestCase):
    async def test_record_combo_order_submission_replays_trade_fills(self):
        websocket = object()
        request = SimpleNamespace(
            group_id='group_replay',
            group_name='Replay Combo',
            account='ACC-1',
            execution_mode='submit',
            execution_intent='open',
            request_source='trial_trigger',
        )
        tracking_legs = [{
            'id': 'leg_replay',
            'conId': 301,
            'localSymbol': 'SPY  240621C00520000',
            'symbol': 'SPY',
            'secType': 'OPT',
            'right': 'C',
            'strike': 520,
            'expDate': '20240621',
            'targetPosition': 1,
            'expectedExecutionSide': 'BOT',
            'ratio': 1,
        }]
        fill = SimpleNamespace(
            execution=SimpleNamespace(
                orderId=940,
                permId=941,
                execId='replay-fill-1',
                shares=1,
                price=4.2,
                side='BOT',
            ),
            contract=SimpleNamespace(secType='OPT', conId=301),
        )
        trade = SimpleNamespace(
            order=SimpleNamespace(orderId=940, account='ACC-1'),
            orderStatus=SimpleNamespace(
                permId=941,
                status='Filled',
                filled=1,
                remaining=0,
                avgFillPrice=4.2,
                lastFillPrice=4.2,
                whyHeld='',
                mktCapPrice=0,
            ),
            fills=[fill],
            log=[],
            advancedError='',
        )
        result = SimpleNamespace(
            order_id=940,
            perm_id=941,
            status='Filled',
            status_message=None,
            tracking_legs=tracking_legs,
            trade=trade,
        )

        try:
            # Simulate the pre-registration callback having failed: no
            # tracking exists yet, so the live exec event for this fill was
            # dropped. The submission record must replay it from trade.fills.
            ib_server._record_combo_order_submission(websocket, request, result)
            await asyncio.sleep(0)

            tracking = ib_server.combo_order_tracking_by_order_id.get(940)
            self.assertIsNotNone(tracking)
            self.assertEqual(tracking['fillTotals']['leg_replay']['filledQuantity'], 1.0)
            self.assertEqual(tracking['fillTotals']['leg_replay']['filledNotional'], 4.2)
            self.assertIn('replay-fill-1', tracking['seenExecIds'])

            # Replaying again must not double-count thanks to exec-id dedup.
            ib_server._record_combo_order_submission(websocket, request, result)
            await asyncio.sleep(0)
            tracking = ib_server.combo_order_tracking_by_order_id.get(940)
            self.assertEqual(tracking['fillTotals']['leg_replay']['filledQuantity'], 1.0)
        finally:
            ib_server.combo_order_tracking_by_order_id.pop(940, None)
            ib_server.combo_order_tracking_by_perm_id.pop(941, None)


if __name__ == '__main__':
    unittest.main()
