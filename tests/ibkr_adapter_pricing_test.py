import asyncio
import pathlib
import sys
import types
import unittest
from types import SimpleNamespace


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


if 'ib_async' not in sys.modules:
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

    def test_resolve_combo_price_increment_uses_es_live_family_default(self):
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

        self.assertEqual(adapter._resolve_combo_price_increment(request=request), 0.25)

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

    def test_quantize_limit_price_respects_es_quarter_point_increment(self):
        quantized = self.adapter._quantize_limit_price(3.18, 'BUY', 0.25)
        self.assertEqual(quantized, 3.0)

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


if __name__ == '__main__':
    unittest.main()
