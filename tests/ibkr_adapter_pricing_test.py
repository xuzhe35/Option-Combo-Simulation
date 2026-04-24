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
from trade_execution.models import ComboOrderRequest
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


if __name__ == '__main__':
    unittest.main()
