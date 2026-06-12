import asyncio
import json
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


class IbServerBroadcastAuthFilterTests(unittest.IsolatedAsyncioTestCase):
    class _RecordingWs:
        def __init__(self):
            self.sent = []

        async def send(self, message):
            self.sent.append(json.loads(message))

    async def test_account_broadcasts_skip_unauthenticated_clients(self):
        authed = self._RecordingWs()
        unauthed = self._RecordingWs()
        stranger = self._RecordingWs()
        original_required = ib_server.WS_AUTH_REQUIRED
        try:
            ib_server.WS_AUTH_REQUIRED = True
            ib_server.connected_clients.update({authed, unauthed, stranger})
            ib_server.ws_client_auth_state[authed] = {'authenticated': True, 'failed_attempts': 0}
            ib_server.ws_client_auth_state[unauthed] = {'authenticated': False, 'failed_attempts': 0}
            # `stranger` has no auth state at all; with auth required it must
            # be treated as unauthenticated.

            ib_server._broadcast_managed_accounts_snapshot()
            ib_server._broadcast_portfolio_avg_cost_items([{'symbol': 'SPY', 'avgCostPerUnit': 1.23}])
            await asyncio.sleep(0)

            authed_actions = [payload.get('action') for payload in authed.sent]
            self.assertIn('managed_accounts_update', authed_actions)
            self.assertIn('portfolio_avg_cost_update', authed_actions)
            self.assertEqual(unauthed.sent, [])
            self.assertEqual(stranger.sent, [])
        finally:
            ib_server.WS_AUTH_REQUIRED = original_required
            ib_server.connected_clients.difference_update({authed, unauthed, stranger})
            ib_server.ws_client_auth_state.pop(authed, None)
            ib_server.ws_client_auth_state.pop(unauthed, None)

    async def test_account_broadcasts_reach_everyone_when_auth_not_required(self):
        client = self._RecordingWs()
        original_required = ib_server.WS_AUTH_REQUIRED
        try:
            ib_server.WS_AUTH_REQUIRED = False
            ib_server.connected_clients.add(client)

            ib_server._broadcast_managed_accounts_snapshot()
            await asyncio.sleep(0)

            self.assertEqual([p.get('action') for p in client.sent], ['managed_accounts_update'])
        finally:
            ib_server.WS_AUTH_REQUIRED = original_required
            ib_server.connected_clients.discard(client)


class IbkrAdapterSubmitPreRegistrationTests(unittest.IsolatedAsyncioTestCase):
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

        preview = SimpleNamespace(
            combo_symbol='SPY',
            combo_exchange='SMART',
            order_action='BUY',
            total_quantity=1,
            limit_price=1.25,
            raw_net_mid=1.25,
            execution_mode='submit',
            account='',
            pricing_source='middle',
            pricing_note='',
            legs=[],
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

        self.assertEqual(events, ['place_order', 'pre_register', 'sleep'])
        self.assertEqual(result.order_id, 4500)
        self.assertEqual(result.perm_id, 4501)
        self.assertIs(result.trade.order, order)


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
