import pathlib
import sys
import types
import unittest


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
    sys.modules['ib_async'] = ib_async


from trade_execution.adapters.ibkr import IbkrExecutionAdapter
from trade_execution.models import ComboOrderRequest


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


if __name__ == '__main__':
    unittest.main()
