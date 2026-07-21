import asyncio
import pathlib
import sys
import time
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
            self.positionEvent = _DummyEvent()
            self.orderStatusEvent = _DummyEvent()
            self.execDetailsEvent = _DummyEvent()
            self.errorEvent = _DummyEvent()

        def isConnected(self):
            return False

        def managedAccounts(self):
            return []

        def positions(self):
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

    def test_manual_concession_uses_the_entered_step_without_tick_substitution(self):
        self.assertEqual(
            self.adapter._resolve_next_manual_concession_limit(2.50, 2.57, 'BUY', 0.07),
            2.57,
        )
        self.assertEqual(
            self.adapter._resolve_next_manual_concession_limit(2.50, 2.43, 'SELL', 0.07),
            2.43,
        )

    def test_manual_concession_requires_a_full_step_before_the_worst_quote(self):
        self.assertEqual(
            self.adapter._resolve_next_manual_concession_limit(2.55, 2.557, 'BUY', 0.01),
            2.55,
        )
        self.assertEqual(
            self.adapter._resolve_next_manual_concession_limit(2.45, 2.443, 'SELL', 0.01),
            2.45,
        )

    def test_manual_concession_offset_is_retained_and_clamped_by_quote_range(self):
        context = {
            'managedConcessionRatio': 0.20,
            'managedManualConcessionOffset': 0.01,
        }
        self.assertEqual(
            self.adapter._resolve_target_limit_from_quote_stats(context, 2.50, 2.40, 2.70),
            2.55,
        )
        self.assertEqual(
            self.adapter._resolve_target_limit_from_quote_stats(context, 2.50, 2.40, 2.51),
            2.51,
        )

    def test_manual_concession_reprices_the_live_order_and_retains_the_offset(self):
        websocket = object()
        order = SimpleNamespace(lmtPrice=2.50, transmit=False)
        trade = SimpleNamespace(order=order)
        context = {
            'groupId': 'group_manual_concession',
            'websocket': websocket,
            'status': 'Submitted',
            'orderAction': 'BUY',
            'trade': trade,
            'comboContract': object(),
            'workingLimitPrice': 2.50,
            'managedConcessionRatio': 0.0,
            'managedManualConcessionCount': 0,
            'managedManualConcessionStep': None,
            'managedManualConcessionOffset': 0.0,
            'maxRepriceCount': self.adapter.managed_reprice_max_updates,
            'timeoutAt': 0,
            'repricingCount': 0,
            'resolvedLegs': [],
        }
        placed_orders = []

        async def quote_stats(_context):
            return {
                'rawNetMid': 2.50,
                'bestPrice': 2.40,
                'worstPrice': 2.60,
            }

        async def unexpected_price_increment(_context, _raw_limit_price):
            raise AssertionError('manual chase must not resolve or substitute a market-rule tick')

        async def no_op(*_args):
            return None

        async def completed_monitor(_context):
            return None

        self.adapter._resolve_order_tracking = lambda _order_id, _perm_id: context
        self.adapter._compute_live_combo_quote_stats = quote_stats
        self.adapter._resolve_context_price_increment = unexpected_price_increment
        self.adapter._cancel_reprice_task_and_wait = no_op
        self.adapter._emit_managed_update = no_op
        self.adapter._managed_reprice_loop = completed_monitor
        self.adapter.ib.placeOrder = lambda contract, submitted_order: placed_orders.append(
            (contract, submitted_order.lmtPrice)
        ) or trade

        snapshot = asyncio.run(self.adapter.concede_managed_combo_order(websocket, {
            'groupId': 'group_manual_concession',
            'orderId': 1640,
            'concessionMode': 'step',
            'concessionStep': 0.03,
        }))

        self.assertEqual(placed_orders, [(context['comboContract'], 2.53)])
        self.assertEqual(context['workingLimitPrice'], 2.53)
        self.assertEqual(context['managedManualConcessionCount'], 1)
        self.assertEqual(context['managedManualConcessionStep'], 0.03)
        self.assertEqual(context['managedManualConcessionOffset'], 0.03)
        self.assertEqual(snapshot['managedManualConcessionCount'], 1)
        self.assertEqual(snapshot['managedManualConcessionStep'], 0.03)

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

    def test_order_path_never_reinjects_a_guessed_weekly_fop_class(self):
        """The order path must agree with the market-data path on FOP classes.

        ``_build_contract_from_request`` re-injects the family default even when
        the browser correctly sends no trading class, so these two copies of
        ``_resolve_weekly_fop_trading_class`` drifting apart would put ML3 on a
        real CL order while the priced quote used the IB-qualified class.
        """
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families=ib_server.SUPPORTED_LIVE_FAMILIES,
            index_exchange_fallbacks={},
        )

        for symbol, exchange, multiplier in (
            ('CL', 'NYMEX', '1000'),
            ('SI', 'COMEX', '5000'),
            ('ES', 'CME', '50'),
        ):
            with self.subTest(symbol=symbol):
                leg_request = ComboLegRequest.from_payload({
                    'id': f'leg_{symbol.lower()}',
                    'type': 'call',
                    'pos': 1,
                    'secType': 'FOP',
                    'symbol': symbol,
                    'underlyingSymbol': symbol,
                    'exchange': exchange,
                    'underlyingExchange': exchange,
                    'currency': 'USD',
                    'multiplier': multiplier,
                    'underlyingMultiplier': multiplier,
                    'right': 'C',
                    'strike': '85',
                    # A Tuesday: ML3/S3T/E3A each name a different weekday.
                    'expDate': '20260804',
                    'contractMonth': '202609',
                    'underlyingContractMonth': '202609',
                })

                contract = adapter._build_contract_from_request(leg_request)
                self.assertEqual(getattr(contract, 'tradingClass', ''), '')
                self.assertEqual(
                    ib_server._resolve_weekly_fop_trading_class(symbol, '20260804', ''),
                    getattr(contract, 'tradingClass', ''),
                )

    def test_ambiguous_spy_option_qualification_prefers_canonical_trading_class(self):
        class _AmbiguousSpyIb(_DummyIb):
            def __init__(self):
                super().__init__()
                self.contract_detail_probes = []

            async def qualifyContractsAsync(self, _contract):
                # Mirrors IB's behaviour for an under-specified SPY option:
                # qualify returns no result because SPY and 2SPY both match.
                return []

            async def reqContractDetailsAsync(self, contract):
                self.contract_detail_probes.append(contract)
                return [
                    SimpleNamespace(
                        contract=SimpleNamespace(
                            conId=864004569,
                            secType='OPT',
                            symbol='SPY',
                            lastTradeDateOrContractMonth='20260717',
                            strike=730.0,
                            right='P',
                            multiplier='100',
                            exchange='SMART',
                            currency='USD',
                            localSymbol='SPY   260717P00730000',
                            tradingClass='SPY',
                        ),
                    ),
                    SimpleNamespace(
                        contract=SimpleNamespace(
                            conId=896715799,
                            secType='OPT',
                            symbol='SPY',
                            lastTradeDateOrContractMonth='20260717',
                            strike=730.0,
                            right='P',
                            multiplier='100',
                            exchange='SMART',
                            currency='USD',
                            localSymbol='2SPY  260717P00730000',
                            tradingClass='2SPY',
                        ),
                    ),
                ]

        ib = _AmbiguousSpyIb()
        adapter = IbkrExecutionAdapter(
            ib=ib,
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
        )
        leg_request = ComboLegRequest.from_payload({
            'id': 'spy_put',
            'type': 'put',
            'pos': -3,
            'secType': 'OPT',
            'symbol': 'SPY',
            'underlyingSymbol': 'SPY',
            'exchange': 'SMART',
            'currency': 'USD',
            'multiplier': '100',
            'right': 'P',
            'strike': 730,
            'expDate': '20260717',
        })

        qualified = asyncio.run(adapter._validate_leg_contract(leg_request))

        self.assertEqual(qualified.conId, 864004569)
        self.assertEqual(qualified.tradingClass, 'SPY')
        self.assertEqual(len(ib.contract_detail_probes), 1)
        self.assertEqual(getattr(ib.contract_detail_probes[0], 'tradingClass', ''), '')

    def test_execution_fop_fallback_filters_on_contract_details_under_con_id(self):
        wrong_contract = SimpleNamespace(
            conId=90001,
            secType='FOP',
            symbol='ES',
            lastTradeDateOrContractMonth='20260717',
            strike=7500.0,
            right='C',
            multiplier='50',
            exchange='CME',
            currency='USD',
            localSymbol='WRONG MONTH',
            tradingClass='EW3',
        )
        right_contract = SimpleNamespace(
            conId=90002,
            secType='FOP',
            symbol='ES',
            lastTradeDateOrContractMonth='20260717',
            strike=7500.0,
            right='C',
            multiplier='50',
            exchange='CME',
            currency='USD',
            localSymbol='RIGHT MONTH',
            tradingClass='EW3',
        )

        class _AmbiguousFopIb(_DummyIb):
            async def reqContractDetailsAsync(self, _contract):
                return [
                    SimpleNamespace(contract=wrong_contract, underConId=60901),
                    SimpleNamespace(contract=right_contract, underConId=60701),
                ]

        adapter = IbkrExecutionAdapter(
            ib=_AmbiguousFopIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families=ib_server.SUPPORTED_LIVE_FAMILIES,
            index_exchange_fallbacks={},
        )
        leg_request = ComboLegRequest.from_payload({
            'id': 'es_call',
            'type': 'call',
            'pos': 1,
            'secType': 'FOP',
            'symbol': 'ES',
            'underlyingSymbol': 'ES',
            'exchange': 'CME',
            'underlyingExchange': 'CME',
            'currency': 'USD',
            'multiplier': '50',
            'underlyingMultiplier': '50',
            'right': 'C',
            'strike': 7500,
            'expDate': '20260717',
            'underlyingContractMonth': '202607',
        })
        selected = asyncio.run(adapter._fallback_qualify_derivative_contract(
            adapter._build_contract_from_request(leg_request),
            leg_request,
            qualified_underlying=SimpleNamespace(conId=60701),
        ))

        self.assertIs(selected, right_contract)

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
    def test_friday_es_fop_request_does_not_force_monday_trading_class(self):
        contract = ib_server._build_contract_from_request({
            'secType': 'FOP',
            'symbol': 'ES',
            'exchange': 'CME',
            'currency': 'USD',
            'multiplier': '50',
            'tradingClass': 'E3A',
            'right': 'C',
            'strike': 7590,
            'expDate': '20260717',
        })

        self.assertEqual(contract.lastTradeDateOrContractMonth, '20260717')
        self.assertEqual(contract.tradingClass, '')

    def test_wednesday_es_fop_request_does_not_fabricate_e3c(self):
        contract = ib_server._build_contract_from_request({
            'secType': 'FOP',
            'symbol': 'ES',
            'exchange': 'CME',
            'currency': 'USD',
            'multiplier': '50',
            'tradingClass': 'E3A',
            'right': 'C',
            'strike': 7520,
            'expDate': '20260722',
        })

        self.assertEqual(contract.lastTradeDateOrContractMonth, '20260722')
        self.assertEqual(contract.tradingClass, '')

    def test_tuesday_cl_fop_request_does_not_force_the_ml3_monday_class(self):
        # ML3 names one Monday week-3 crude listing.  2026-08-04 is a Tuesday,
        # so asserting that class rejected an option IB qualified correctly.
        contract = ib_server._build_contract_from_request({
            'secType': 'FOP',
            'symbol': 'CL',
            'exchange': 'NYMEX',
            'currency': 'USD',
            'multiplier': '1000',
            'tradingClass': 'ML3',
            'right': 'C',
            'strike': 85,
            'expDate': '20260804',
        })

        self.assertEqual(contract.lastTradeDateOrContractMonth, '20260804')
        self.assertEqual(contract.tradingClass, '')

    def test_silver_fop_requests_also_drop_their_guessed_weekly_class(self):
        contract = ib_server._build_contract_from_request({
            'secType': 'FOP',
            'symbol': 'SI',
            'exchange': 'COMEX',
            'currency': 'USD',
            'multiplier': '5000',
            'tradingClass': 'S3T',
            'right': 'P',
            'strike': 30,
            'expDate': '20260804',
        })

        self.assertEqual(contract.tradingClass, '')

    def test_index_option_requests_keep_their_real_trading_class(self):
        # SPXW/NDXP are stable class names, not weekday guesses.
        contract = ib_server._build_contract_from_request({
            'secType': 'OPT',
            'symbol': 'SPX',
            'exchange': 'CBOE',
            'currency': 'USD',
            'multiplier': '100',
            'tradingClass': 'SPXW',
            'right': 'C',
            'strike': 7000,
            'expDate': '20260804',
        })

        self.assertEqual(contract.tradingClass, 'SPXW')

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

    def test_supported_live_families_include_silver_futures_options(self):
        self.assertEqual(ib_server.SUPPORTED_LIVE_FAMILIES['SI']['underlying_sec_type'], 'FUT')
        self.assertEqual(ib_server.SUPPORTED_LIVE_FAMILIES['SI']['option_sec_type'], 'FOP')
        self.assertEqual(ib_server.SUPPORTED_LIVE_FAMILIES['SI']['underlying_symbol'], 'SI')
        self.assertEqual(ib_server.SUPPORTED_LIVE_FAMILIES['SI']['option_symbol'], 'SI')
        self.assertEqual(ib_server.SUPPORTED_LIVE_FAMILIES['SI']['exchange'], 'COMEX')
        self.assertEqual(ib_server.SUPPORTED_LIVE_FAMILIES['SI']['multiplier'], '5000')
        self.assertEqual(ib_server.SUPPORTED_LIVE_FAMILIES['SI']['trading_class'], 'S3T')

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

        si_request = ib_server._build_underlying_request('SI', [{'expDate': '20260526'}])
        self.assertEqual(si_request['secType'], 'FUT')
        self.assertEqual(si_request['symbol'], 'SI')
        self.assertEqual(si_request['exchange'], 'COMEX')
        self.assertEqual(si_request['multiplier'], '5000')
        self.assertEqual(si_request['contractMonth'], '202605')


class IbServerFopContractIdentityTests(unittest.TestCase):
    def setUp(self):
        self._original_ib = ib_server.ib
        self._original_timing = dict(ib_server.option_contract_timing_by_con_id)
        self._original_underlying_months = dict(ib_server.underlying_contract_month_by_con_id)
        self._original_qualified_underlyings = dict(ib_server.qualified_underlyings)
        ib_server.option_contract_timing_by_con_id.clear()
        ib_server.underlying_contract_month_by_con_id.clear()
        ib_server.qualified_underlyings.clear()

    def tearDown(self):
        ib_server.ib = self._original_ib
        ib_server.option_contract_timing_by_con_id.clear()
        ib_server.option_contract_timing_by_con_id.update(self._original_timing)
        ib_server.underlying_contract_month_by_con_id.clear()
        ib_server.underlying_contract_month_by_con_id.update(self._original_underlying_months)
        ib_server.qualified_underlyings.clear()
        ib_server.qualified_underlyings.update(self._original_qualified_underlyings)

    def test_futures_month_lookup_does_not_share_the_option_timing_semaphore(self):
        """A FOP timing resolution awaits the futures month while holding a permit.

        Sharing one semaphore is re-entrant: once capacity-many FOP resolutions
        are in flight with an unresolvable underlying month, every permit is held
        by a task waiting on a nested task that can never acquire one, and the
        semaphore stays drained for the life of the process.
        """
        self.assertIsNot(
            ib_server.futures_contract_month_semaphore,
            ib_server.option_contract_timing_semaphore,
        )

    def test_concurrent_fop_timing_resolutions_do_not_deadlock(self):
        capacity = ib_server.option_contract_timing_semaphore._value
        option_details = {}
        for con_id in range(9001, 9001 + capacity):
            option_details[con_id] = SimpleNamespace(
                contract=SimpleNamespace(
                    conId=con_id, secType='FOP', symbol='ES',
                    localSymbol=f'ES {con_id}', lastTradeDateOrContractMonth='20260717',
                    strike=7500.0, right='C', multiplier='50', exchange='CME',
                    tradingClass='EW3',
                ),
                underConId=70001,
                lastTradeTime='15:00:00', timeZoneId='US/Central',
                realExpirationDate='20260717',
            )

        class _NoUnderlyingMonthIb:
            """IB never supplies contractMonth, so the month is never cached."""

            async def reqContractDetailsAsync(self, contract):
                con_id = getattr(contract, 'conId', None)
                await asyncio.sleep(0)
                if con_id in option_details:
                    return [option_details[con_id]]
                if con_id == 70001:
                    return [SimpleNamespace(contract=SimpleNamespace(
                        conId=70001, secType='FUT', symbol='ES',
                        lastTradeDateOrContractMonth='20260918',
                    ))]
                return []

        ib_server.ib = _NoUnderlyingMonthIb()

        async def drive():
            return await asyncio.wait_for(
                asyncio.gather(*(
                    ib_server._resolve_option_contract_timing(details.contract)
                    for details in option_details.values()
                )),
                timeout=10,
            )

        results = asyncio.run(drive())

        self.assertEqual(len(results), capacity)
        # The permit pool must be fully returned, not drained.
        self.assertEqual(
            ib_server.option_contract_timing_semaphore._value, capacity
        )

    def test_energy_future_delivery_month_survives_an_earlier_expiry(self):
        # CLU6 delivers in Sep 2026 but stops trading 2026-08-20, so the month
        # must come from ContractDetails.contractMonth, never from that date.
        future_contract = SimpleNamespace(
            conId=70102,
            secType='FUT',
            symbol='CL',
            localSymbol='CLU6',
            lastTradeDateOrContractMonth='20260820',
        )

        class _ContractDetailsIb:
            def __init__(self):
                self.calls = []

            async def reqContractDetailsAsync(self, contract):
                self.calls.append(getattr(contract, 'conId', None))
                return [SimpleNamespace(
                    contract=future_contract, contractMonth='202609'
                )]

        fake_ib = _ContractDetailsIb()
        ib_server.ib = fake_ib

        month = asyncio.run(ib_server._resolve_verified_futures_contract_month(70102))

        self.assertEqual(month, '202609')
        self.assertEqual(ib_server.underlying_contract_month_by_con_id[70102], '202609')

        cached = asyncio.run(ib_server._resolve_verified_futures_contract_month(70102))
        self.assertEqual(cached, '202609')
        self.assertEqual(fake_ib.calls, [70102])

    def test_future_month_stays_unresolved_without_contract_details_evidence(self):
        future_contract = SimpleNamespace(
            conId=70103,
            secType='FUT',
            symbol='CL',
            localSymbol='CLV6',
            lastTradeDateOrContractMonth='20260921',
        )

        class _MonthlessDetailsIb:
            async def reqContractDetailsAsync(self, contract):
                return [SimpleNamespace(contract=future_contract)]

        ib_server.ib = _MonthlessDetailsIb()

        month = asyncio.run(ib_server._resolve_verified_futures_contract_month(70103))

        # A date-derived guess (202609) would be wrong for an Oct 2026 contract.
        self.assertEqual(month, '')
        self.assertNotIn(70103, ib_server.underlying_contract_month_by_con_id)

    def test_derivative_fallback_filters_on_contract_details_under_con_id(self):
        def detail(con_id, under_con_id):
            return SimpleNamespace(
                contract=SimpleNamespace(
                    conId=con_id,
                    secType='FOP',
                    symbol='ES',
                    lastTradeDateOrContractMonth='20260717',
                    strike=7500.0,
                    right='C',
                    multiplier='50',
                    exchange='CME',
                    tradingClass='EW3',
                ),
                underConId=under_con_id,
            )

        selected = ib_server._filter_derivative_contract_candidates(
            [detail(501, 70001), detail(502, 70002)],
            {
                'secType': 'FOP',
                'symbol': 'ES',
                'expDate': '20260717',
                'strike': 7500.0,
                'right': 'C',
                'multiplier': '50',
                'exchange': 'CME',
            },
            qualified_underlying=SimpleNamespace(conId=70002),
        )

        self.assertEqual([candidate.conId for candidate in selected], [502])

    def test_derivative_fallback_rejects_details_without_under_con_id(self):
        candidate = SimpleNamespace(
            conId=503,
            secType='FOP',
            symbol='ES',
            lastTradeDateOrContractMonth='20260717',
            strike=7500.0,
            right='C',
            multiplier='50',
            exchange='CME',
            tradingClass='EW3',
        )

        selected = ib_server._filter_derivative_contract_candidates(
            [SimpleNamespace(contract=candidate)],
            {
                'secType': 'FOP',
                'symbol': 'ES',
                'expDate': '20260717',
                'strike': 7500.0,
                'right': 'C',
                'multiplier': '50',
                'exchange': 'CME',
            },
            qualified_underlying=SimpleNamespace(conId=70002),
        )

        self.assertEqual(selected, [])

    def test_option_details_under_con_id_resolves_actual_futures_month(self):
        option_contract = SimpleNamespace(
            conId=501,
            secType='FOP',
            symbol='ES',
            localSymbol='ES   260717C07500000',
            lastTradeDateOrContractMonth='20260717',
            strike=7500.0,
            right='C',
            multiplier='50',
            exchange='CME',
            currency='USD',
            tradingClass='EW3',
            # Deliberately wrong local hints: neither may become payload truth.
            underConId=99999,
            underlyingContractMonth='202612',
        )
        option_details = SimpleNamespace(
            contract=option_contract,
            underConId=70001,
            lastTradeTime='15:00:00',
            timeZoneId='US/Central',
            realExpirationDate='20260717',
        )
        future_contract = SimpleNamespace(
            conId=70001,
            secType='FUT',
            symbol='ES',
            lastTradeDateOrContractMonth='20260918',
        )

        class _ContractDetailsIb:
            def __init__(self):
                self.calls = []

            async def reqContractDetailsAsync(self, contract):
                con_id = getattr(contract, 'conId', None)
                self.calls.append(con_id)
                if con_id == 501:
                    return [option_details]
                if con_id == 70001:
                    return [SimpleNamespace(
                        contract=future_contract, contractMonth='202609'
                    )]
                return []

        fake_ib = _ContractDetailsIb()
        ib_server.ib = fake_ib

        identity = asyncio.run(ib_server._resolve_option_contract_timing(option_contract))

        self.assertEqual(identity['conId'], 501)
        self.assertEqual(identity['localSymbol'], 'ES   260717C07500000')
        self.assertEqual(identity['tradingClass'], 'EW3')
        self.assertEqual(identity['right'], 'C')
        self.assertEqual(identity['strike'], 7500.0)
        self.assertEqual(identity['optionExpiry'], '20260717')
        self.assertEqual(identity['underConId'], 70001)
        self.assertEqual(identity['underlyingContractMonth'], '202609')
        self.assertIs(identity['underlyingBindingVerified'], True)
        self.assertEqual(identity['underlyingBindingSource'], 'ib_contract_details_under_con_id')
        self.assertEqual(fake_ib.calls, [501, 70001])

        cached = asyncio.run(ib_server._resolve_option_contract_timing(option_contract))
        self.assertEqual(cached['underlyingContractMonth'], '202609')
        self.assertEqual(fake_ib.calls, [501, 70001])

    def test_incomplete_option_contract_timing_is_retried_on_next_resolution(self):
        option_contract = SimpleNamespace(
            conId=601,
            secType='OPT',
            symbol='SPY',
            localSymbol='SPY   260724P00750000',
            lastTradeDateOrContractMonth='20260724',
            strike=750.0,
            right='P',
            multiplier='100',
            exchange='SMART',
            currency='USD',
            tradingClass='SPY',
        )
        incomplete_details = SimpleNamespace(
            contract=option_contract,
            lastTradeTime='',
            timeZoneId='US/Eastern',
            realExpirationDate='20260724',
        )
        complete_details = SimpleNamespace(
            contract=option_contract,
            lastTradeTime='16:00:00',
            timeZoneId='US/Eastern',
            realExpirationDate='20260724',
        )

        class _RecoveringContractDetailsIb:
            def __init__(self):
                self.calls = []

            async def reqContractDetailsAsync(self, contract):
                self.calls.append(getattr(contract, 'conId', None))
                details = incomplete_details if len(self.calls) == 1 else complete_details
                return [details]

        fake_ib = _RecoveringContractDetailsIb()
        ib_server.ib = fake_ib

        first = asyncio.run(ib_server._resolve_option_contract_timing(option_contract))
        self.assertNotIn('expiryAsOf', first)

        recovered = asyncio.run(ib_server._resolve_option_contract_timing(option_contract))
        self.assertEqual(recovered['expiryAsOf'], '2026-07-24T20:00:00.000Z')
        self.assertEqual(fake_ib.calls, [601, 601])

        cached = asyncio.run(ib_server._resolve_option_contract_timing(option_contract))
        self.assertEqual(cached['expiryAsOf'], '2026-07-24T20:00:00.000Z')
        self.assertEqual(fake_ib.calls, [601, 601])

    def test_concurrent_option_timing_callers_share_one_contract_details_lookup(self):
        option_contract = SimpleNamespace(
            conId=606,
            secType='OPT',
            symbol='SPY',
            localSymbol='SPY   260724C00750000',
            lastTradeDateOrContractMonth='20260724',
            strike=750.0,
            right='C',
            multiplier='100',
            exchange='SMART',
            currency='USD',
            tradingClass='SPY',
        )
        complete_details = SimpleNamespace(
            contract=option_contract,
            lastTradeTime='16:00:00',
            timeZoneId='US/Eastern',
            realExpirationDate='20260724',
        )

        class _LatchedContractDetailsIb:
            def __init__(self):
                self.calls = 0
                self.lookup_started = None
                self.release_lookup = None

            async def reqContractDetailsAsync(self, _contract):
                self.calls += 1
                self.lookup_started.set()
                await self.release_lookup.wait()
                return [complete_details]

        fake_ib = _LatchedContractDetailsIb()
        ib_server.ib = fake_ib

        async def resolve_concurrently():
            fake_ib.lookup_started = asyncio.Event()
            fake_ib.release_lookup = asyncio.Event()
            first_task = asyncio.create_task(
                ib_server._resolve_option_contract_timing(option_contract)
            )
            await fake_ib.lookup_started.wait()
            second_task = asyncio.create_task(
                ib_server._resolve_option_contract_timing(option_contract)
            )
            # Give the second caller a scheduling turn while the first caller
            # still owns the resolver semaphore and ContractDetails is pending.
            await asyncio.sleep(0)
            fake_ib.release_lookup.set()
            return await asyncio.gather(first_task, second_task)

        first, second = asyncio.run(resolve_concurrently())

        self.assertEqual(fake_ib.calls, 1)
        self.assertEqual(first, second)
        self.assertEqual(first['expiryAsOf'], '2026-07-24T20:00:00.000Z')
        self.assertEqual(first['conId'], 606)

    def test_fop_verified_binding_without_expiry_timing_is_still_retried(self):
        option_contract = SimpleNamespace(
            conId=611,
            secType='FOP',
            symbol='ES',
            localSymbol='ES   260724P07500000',
            lastTradeDateOrContractMonth='20260724',
            strike=7500.0,
            right='P',
            multiplier='50',
            exchange='CME',
            currency='USD',
            tradingClass='EW4',
        )
        incomplete_details = SimpleNamespace(
            contract=option_contract,
            underConId=71001,
            lastTradeTime='',
            timeZoneId='US/Central',
            realExpirationDate='20260724',
        )
        complete_details = SimpleNamespace(
            contract=option_contract,
            underConId=71001,
            lastTradeTime='15:00:00',
            timeZoneId='US/Central',
            realExpirationDate='20260724',
        )
        future_contract = SimpleNamespace(
            conId=71001,
            secType='FUT',
            symbol='ES',
            lastTradeDateOrContractMonth='20260918',
        )

        class _RecoveringFopTimingIb:
            def __init__(self):
                self.calls = []
                self.option_calls = 0

            async def reqContractDetailsAsync(self, contract):
                con_id = getattr(contract, 'conId', None)
                self.calls.append(con_id)
                if con_id == 611:
                    self.option_calls += 1
                    details = (
                        incomplete_details
                        if self.option_calls == 1
                        else complete_details
                    )
                    return [details]
                if con_id == 71001:
                    return [SimpleNamespace(
                        contract=future_contract, contractMonth='202609'
                    )]
                return []

        fake_ib = _RecoveringFopTimingIb()
        ib_server.ib = fake_ib

        first = asyncio.run(ib_server._resolve_option_contract_timing(option_contract))
        self.assertIs(first['underlyingBindingVerified'], True)
        self.assertEqual(first['underlyingContractMonth'], '202609')
        self.assertNotIn('expiryAsOf', first)

        recovered = asyncio.run(ib_server._resolve_option_contract_timing(option_contract))
        self.assertEqual(recovered['expiryAsOf'], '2026-07-24T20:00:00.000Z')
        self.assertIs(recovered['underlyingBindingVerified'], True)
        self.assertEqual(fake_ib.calls, [611, 71001, 611])

    def test_fop_expiry_timing_without_verified_binding_is_still_retried(self):
        option_contract = SimpleNamespace(
            conId=621,
            secType='FOP',
            symbol='ES',
            localSymbol='ES   260724C07500000',
            lastTradeDateOrContractMonth='20260724',
            strike=7500.0,
            right='C',
            multiplier='50',
            exchange='CME',
            currency='USD',
            tradingClass='EW4',
        )
        unbound_details = SimpleNamespace(
            contract=option_contract,
            lastTradeTime='15:00:00',
            timeZoneId='US/Central',
            realExpirationDate='20260724',
        )
        bound_details = SimpleNamespace(
            contract=option_contract,
            underConId=72001,
            lastTradeTime='15:00:00',
            timeZoneId='US/Central',
            realExpirationDate='20260724',
        )
        future_contract = SimpleNamespace(
            conId=72001,
            secType='FUT',
            symbol='ES',
            lastTradeDateOrContractMonth='20260918',
        )

        class _RecoveringFopBindingIb:
            def __init__(self):
                self.option_calls = 0

            async def reqContractDetailsAsync(self, contract):
                con_id = getattr(contract, 'conId', None)
                if con_id == 621:
                    self.option_calls += 1
                    details = unbound_details if self.option_calls == 1 else bound_details
                    return [details]
                if con_id == 72001:
                    return [SimpleNamespace(
                        contract=future_contract, contractMonth='202609'
                    )]
                return []

        fake_ib = _RecoveringFopBindingIb()
        ib_server.ib = fake_ib

        first = asyncio.run(ib_server._resolve_option_contract_timing(option_contract))
        self.assertEqual(first['expiryAsOf'], '2026-07-24T20:00:00.000Z')
        self.assertIs(first['underlyingBindingVerified'], False)

        recovered = asyncio.run(ib_server._resolve_option_contract_timing(option_contract))
        self.assertEqual(recovered['expiryAsOf'], '2026-07-24T20:00:00.000Z')
        self.assertIs(recovered['underlyingBindingVerified'], True)
        self.assertEqual(recovered['underlyingContractMonth'], '202609')
        self.assertEqual(fake_ib.option_calls, 2)


class IbServerPortfolioPositionSnapshotTests(unittest.TestCase):
    def setUp(self):
        self._original_ib = ib_server.ib
        self._original_cache = dict(ib_server.portfolio_position_cache)
        self._original_ready = ib_server.portfolio_positions_snapshot_ready

    def tearDown(self):
        ib_server.ib = self._original_ib
        ib_server.portfolio_position_cache.clear()
        ib_server.portfolio_position_cache.update(self._original_cache)
        ib_server.portfolio_positions_snapshot_ready = self._original_ready

    def test_snapshot_reads_fop_positions_from_req_positions_collection(self):
        class _ConnectedIb:
            def isConnected(self):
                return True

            def positions(self):
                return [
                    SimpleNamespace(
                        account='U19322426',
                        position=-4,
                        contract=SimpleNamespace(
                            conId=91001,
                            secType='FOP',
                            symbol='ES',
                            localSymbol='ES   260717C07590000',
                            lastTradeDateOrContractMonth='20260717',
                            right='C',
                            strike=7590,
                            multiplier='50',
                            tradingClass='EW3',
                        ),
                    ),
                    SimpleNamespace(
                        account='U19322426',
                        position=-4,
                        contract=SimpleNamespace(
                            conId=91002,
                            secType='FOP',
                            symbol='ES',
                            localSymbol='ES   260717P07590000',
                            lastTradeDateOrContractMonth='20260717',
                            right='P',
                            strike=7590,
                            multiplier='50',
                            tradingClass='EW3',
                        ),
                    ),
                ]

        ib_server.ib = _ConnectedIb()
        ib_server.portfolio_position_cache.clear()
        ib_server.portfolio_positions_snapshot_ready = False

        payload = ib_server._build_portfolio_positions_payload()

        self.assertTrue(payload['ibConnected'])
        self.assertTrue(payload['positionsReady'])
        self.assertEqual(len(payload['items']), 2)
        self.assertEqual(
            [(item['right'], item['position'], item['tradingClass']) for item in payload['items']],
            [('C', -4.0, 'EW3'), ('P', -4.0, 'EW3')],
        )
        self.assertEqual(len(ib_server.portfolio_position_cache), 2)


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

    def _build_stock_close_leg(self, leg_id, pos, symbol='GLD'):
        return ComboLegRequest.from_payload({
            'id': leg_id,
            'type': 'stock',
            'pos': pos,
            'secType': 'STK',
            'symbol': symbol,
            'underlyingSymbol': symbol,
            'exchange': 'SMART',
            'underlyingExchange': 'SMART',
            'currency': 'USD',
        })

    def _authorize_close_request(self, adapter, request, planned_orders=None):
        request.close_confirmation_target_mode = request.execution_mode
        close_plan = adapter._build_assignment_aware_close_plan(request)
        token, _record = adapter._register_close_plan_confirmation(
            request,
            close_plan,
            planned_orders or [],
        )
        request.close_plan_token = token
        adapter._validate_close_plan_confirmation(request, close_plan, 'validate')
        return token

    def test_close_plan_uses_matching_tws_option_positions(self):
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
            ],
        )
        request = ComboOrderRequest(
            group_id='group_gld',
            group_name='GLD Checked Close',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            legs=[
                self._build_close_leg('short_call', 16, 'C'),
                self._build_close_leg('long_call', -22, 'C', exp_date='20260717'),
                self._build_close_leg('long_put', -24, 'P', exp_date='20260717'),
            ],
        )

        plan = adapter._build_assignment_aware_close_plan(request)

        self.assertEqual([leg.id for leg in plan['optionRequest'].legs], ['short_call', 'long_call', 'long_put'])
        self.assertEqual([leg.pos for leg in plan['optionRequest'].legs], [16, -22, -24])
        self.assertEqual(plan['underlyingLegs'], [])
        self.assertEqual(plan['assignmentAdjustments'], [])

    def test_close_plan_rejects_missing_option_instead_of_inferred_assignment(self):
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            portfolio_positions_provider=lambda: [
                {'account': 'U1', 'secType': 'STK', 'symbol': 'GLD', 'position': 1000},
            ],
        )
        request = ComboOrderRequest(
            group_id='group_gld_missing',
            group_name='GLD Missing Option Close',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            legs=[self._build_close_leg('partial_put', 16, 'P')],
        )

        with self.assertRaisesRegex(ValueError, 'Close blocked.*may be simulated.*convert that option leg'):
            adapter._build_assignment_aware_close_plan(request)

    def test_close_plan_rejects_partial_option_position(self):
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            portfolio_positions_provider=lambda: [
                {'account': 'U1', 'secType': 'OPT', 'symbol': 'GLD', 'expDate': '20260618', 'right': 'P', 'strike': 415, 'position': -6},
            ],
        )
        request = ComboOrderRequest(
            group_id='group_gld_partial',
            group_name='GLD Partial Option Close',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            legs=[self._build_close_leg('partial_put', 16, 'P')],
        )

        with self.assertRaisesRegex(ValueError, 'requested close quantity 16.*only 6'):
            adapter._build_assignment_aware_close_plan(request)

    def test_close_plan_closes_explicit_underlying_leg_when_tws_position_exists(self):
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
        request = ComboOrderRequest(
            group_id='group_gld_underlying',
            group_name='GLD Underlying Close',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            close_confirmation_target_mode='submit',
            legs=[self._build_stock_close_leg('stock_leg', -1600)],
        )

        plan = adapter._build_assignment_aware_close_plan(request)

        self.assertEqual(plan['optionRequest'].legs, [])
        self.assertEqual(plan['underlyingLegs'][0].id, 'stock_leg')
        self.assertEqual(plan['underlyingLegs'][0].pos, -1600)
        self.assertEqual(plan['assignmentAdjustments'], [])

    def test_auto_equivalent_close_ignores_one_cent_otm_leg(self):
        option_leg = self._build_close_leg('otm_call', -1, 'C', strike=800, exp_date='20260717')
        option_leg.observed_ask = 0.01
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            portfolio_positions_provider=lambda: [
                {'account': 'U1', 'secType': 'OPT', 'symbol': 'GLD', 'expDate': '20260717', 'right': 'C', 'strike': 800, 'position': 1},
            ],
        )
        request = ComboOrderRequest(
            group_id='group_otm_equivalent',
            group_name='OTM Equivalent',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            close_strategy='auto',
            observed_underlying_price=730,
            profile={'underlyingSecType': 'STK', 'underlyingSymbol': 'GLD'},
            legs=[option_leg],
        )

        plan = adapter._build_assignment_aware_close_plan(request)

        self.assertEqual(plan['optionRequest'].legs, [])
        self.assertEqual(plan['underlyingLegs'], [])
        self.assertEqual(plan['assignmentAdjustments'][0]['classification'], 'otm_ignored')
        self.assertEqual(plan['assignmentAdjustments'][0]['requiredUnderlyingQuantity'], 0)

    def test_auto_equivalent_close_hedges_deep_itm_one_sided_call(self):
        option_leg = self._build_close_leg('deep_call', -1, 'C', strike=700, exp_date='20260717')
        option_leg.observed_bid = 29.8
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            portfolio_positions_provider=lambda: [
                {'account': 'U1', 'secType': 'OPT', 'symbol': 'GLD', 'expDate': '20260717', 'right': 'C', 'strike': 700, 'position': 1},
            ],
        )
        request = ComboOrderRequest(
            group_id='group_itm_equivalent',
            group_name='ITM Equivalent',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            close_strategy='auto',
            observed_underlying_price=730,
            profile={'underlyingSecType': 'STK', 'underlyingSymbol': 'GLD'},
            legs=[option_leg],
        )

        plan = adapter._build_assignment_aware_close_plan(request)

        self.assertEqual(plan['optionRequest'].legs, [])
        self.assertEqual(len(plan['underlyingLegs']), 1)
        self.assertEqual(plan['underlyingLegs'][0].sec_type, 'STK')
        self.assertEqual(plan['underlyingLegs'][0].pos, -100)
        adjustment = plan['assignmentAdjustments'][0]
        self.assertEqual(adjustment['classification'], 'itm_hedged')
        self.assertEqual(adjustment['requiredUnderlyingQuantity'], -100)
        self.assertEqual(adjustment['executedUnderlyingQuantity'], -100)

    def test_manual_equivalent_close_nets_same_expiry_underlying_requirements(self):
        call_leg = self._build_close_leg('long_call', -1, 'C', strike=700, exp_date='20260717')
        put_leg = self._build_close_leg('long_put', -1, 'P', strike=760, exp_date='20260717')
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            portfolio_positions_provider=lambda: [
                {'account': 'U1', 'secType': 'OPT', 'symbol': 'GLD', 'expDate': '20260717', 'right': 'C', 'strike': 700, 'position': 1},
                {'account': 'U1', 'secType': 'OPT', 'symbol': 'GLD', 'expDate': '20260717', 'right': 'P', 'strike': 760, 'position': 1},
            ],
        )
        request = ComboOrderRequest(
            group_id='group_net_equivalent',
            group_name='Net Equivalent',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            close_strategy='equivalent_expiry',
            observed_underlying_price=730,
            profile={'underlyingSecType': 'STK', 'underlyingSymbol': 'GLD'},
            legs=[call_leg, put_leg],
        )

        plan = adapter._build_assignment_aware_close_plan(request)

        self.assertEqual(plan['underlyingLegs'], [])
        self.assertEqual(plan['optionRequest'].legs, [])
        self.assertEqual(
            [item['requiredUnderlyingQuantity'] for item in plan['assignmentAdjustments']],
            [-100, 100],
        )
        self.assertEqual(
            [item['executedUnderlyingQuantity'] for item in plan['assignmentAdjustments']],
            [0, 0],
        )
        self.assertEqual(
            [item['internallyNettedUnderlyingQuantity'] for item in plan['assignmentAdjustments']],
            [-100, 100],
        )

    def test_equivalent_close_blocks_adjusted_trading_class(self):
        option_leg = self._build_close_leg('adjusted_call', -1, 'C', strike=700, exp_date='20260717')
        option_leg.trading_class = 'GLD1'
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            portfolio_positions_provider=lambda: [
                {'account': 'U1', 'secType': 'OPT', 'symbol': 'GLD', 'expDate': '20260717', 'right': 'C', 'strike': 700, 'position': 1},
            ],
        )
        request = ComboOrderRequest(
            group_id='group_adjusted_equivalent',
            group_name='Adjusted Equivalent',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            close_strategy='equivalent_expiry',
            observed_underlying_price=730,
            profile={'underlyingSecType': 'STK', 'underlyingSymbol': 'GLD'},
            legs=[option_leg],
        )

        with self.assertRaisesRegex(ValueError, 'adjusted/non-standard trading classes'):
            adapter._build_assignment_aware_close_plan(request)

    async def test_submit_otm_only_equivalent_close_returns_filled_adjustment_without_order(self):
        option_leg = self._build_close_leg('otm_call', -1, 'C', strike=800, exp_date='20260717')
        option_leg.observed_ask = 0.01
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            portfolio_positions_provider=lambda: [
                {'account': 'U1', 'secType': 'OPT', 'symbol': 'GLD', 'expDate': '20260717', 'right': 'C', 'strike': 800, 'position': 1},
            ],
        )
        request = ComboOrderRequest(
            group_id='group_otm_no_order',
            group_name='OTM No Order',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            close_strategy='auto',
            observed_underlying_price=730,
            profile={'underlyingSecType': 'STK', 'underlyingSymbol': 'GLD'},
            legs=[option_leg],
        )

        self._authorize_close_request(adapter, request, [])
        result = await adapter.submit_combo_order(object(), request)

        self.assertEqual(result.status, 'Filled')
        self.assertIsNone(result.order_id)
        self.assertTrue(result.preview.close_plan_complete)
        self.assertEqual(result.preview.assignment_adjustments[0]['classification'], 'otm_ignored')

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

    async def test_preview_explicit_underlying_close_shows_underlying_stage(self):
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
            group_id='group_preview_underlying',
            group_name='GLD Preview Underlying',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='preview',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            close_confirmation_target_mode='submit',
            legs=[self._build_stock_close_leg('stock_leg', -1600)],
        )

        preview = await adapter.preview_combo_order(object(), request)

        self.assertEqual(resolved_leg_ids, ['stock_leg'])
        self.assertEqual(preview.request_source, 'close_group_underlying')
        self.assertEqual(preview.close_plan_stage, 'underlying')
        self.assertEqual(preview.close_plan_complete, False)
        self.assertEqual(preview.legs[0].sec_type, 'STK')
        self.assertEqual(preview.assignment_adjustments, [])
        self.assertIn('account-level TWS portfolio positions', preview.pricing_note)
        self.assertTrue(preview.close_plan_token)
        self.assertTrue(preview.close_plan_expires_at)
        self.assertEqual(preview.close_plan_orders[0]['orderKind'], 'underlying')
        self.assertEqual(preview.close_plan_orders[0]['orderAction'], 'SELL')
        self.assertEqual(preview.close_plan_orders[0]['quantity'], 1600)
        self.assertEqual(preview.close_plan_legs[0]['treatment'], 'underlying_close')

    async def test_close_submit_without_confirmation_token_is_blocked_before_order_build(self):
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            portfolio_positions_provider=lambda: [
                {'account': 'U1', 'secType': 'OPT', 'symbol': 'GLD', 'expDate': '20260618', 'right': 'C', 'strike': 415, 'position': -1},
            ],
        )
        request = ComboOrderRequest(
            group_id='group_unconfirmed_close',
            group_name='Unconfirmed Close',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            legs=[self._build_close_leg('short_call', 1, 'C')],
        )

        with self.assertRaisesRegex(ValueError, 'preview the complete Close Plan and confirm it'):
            await adapter.submit_combo_order(object(), request)

    def test_confirmation_rejects_when_frozen_plan_payload_changes(self):
        option_leg = self._build_close_leg('short_call', 1, 'C')
        option_leg.observed_bid = 2.0
        option_leg.observed_ask = 2.2
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            portfolio_positions_provider=lambda: [
                {'account': 'U1', 'secType': 'OPT', 'symbol': 'GLD', 'expDate': '20260618', 'right': 'C', 'strike': 415, 'position': -1},
            ],
        )
        request = ComboOrderRequest(
            group_id='group_changed_close',
            group_name='Changed Close',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            close_confirmation_target_mode='submit',
            legs=[option_leg],
        )
        close_plan = adapter._build_assignment_aware_close_plan(request)
        token, _record = adapter._register_close_plan_confirmation(request, close_plan, [])
        request.close_plan_token = token
        option_leg.observed_ask = 2.3
        changed_plan = adapter._build_assignment_aware_close_plan(request)

        with self.assertRaisesRegex(ValueError, 'plan changed after preview'):
            adapter._validate_close_plan_confirmation(request, changed_plan, 'validate')

    def test_confirmation_token_expires_and_cannot_be_reused(self):
        option_leg = self._build_close_leg('short_call', 1, 'C')
        option_leg.observed_bid = 2.0
        option_leg.observed_ask = 2.2
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            portfolio_positions_provider=lambda: [
                {'account': 'U1', 'secType': 'OPT', 'symbol': 'GLD', 'expDate': '20260618', 'right': 'C', 'strike': 415, 'position': -1},
            ],
        )
        request = ComboOrderRequest(
            group_id='group_one_time_close',
            group_name='One-time Close',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            close_confirmation_target_mode='submit',
            legs=[option_leg],
        )
        close_plan = adapter._build_assignment_aware_close_plan(request)
        token, record = adapter._register_close_plan_confirmation(request, close_plan, [])
        request.close_plan_token = token

        adapter._validate_close_plan_confirmation(request, close_plan, 'validate')
        adapter._validate_close_plan_confirmation(request, close_plan, 'submit')
        with self.assertRaisesRegex(ValueError, 'expired or is no longer valid'):
            adapter._validate_close_plan_confirmation(request, close_plan, 'submit')

        second_token, second_record = adapter._register_close_plan_confirmation(request, close_plan, [])
        request.close_plan_token = second_token
        second_record['expiresMonotonic'] = time.monotonic() - 1
        with self.assertRaisesRegex(ValueError, 'expired or is no longer valid'):
            adapter._validate_close_plan_confirmation(request, close_plan, 'validate')

    def test_new_confirmation_supersedes_previous_plan_in_the_same_scope(self):
        option_leg = self._build_close_leg('short_call', 1, 'C')
        option_leg.observed_bid = 2.0
        option_leg.observed_ask = 2.2
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            portfolio_positions_provider=lambda: [
                {'account': 'U1', 'secType': 'OPT', 'symbol': 'GLD', 'expDate': '20260618', 'right': 'C', 'strike': 415, 'position': -1},
            ],
        )
        request = ComboOrderRequest(
            group_id='group_single_active_plan',
            group_name='Single Active Plan',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            close_confirmation_target_mode='submit',
            legs=[option_leg],
        )
        close_plan = adapter._build_assignment_aware_close_plan(request)
        first_token, _first_record = adapter._register_close_plan_confirmation(request, close_plan, [])
        second_token, _second_record = adapter._register_close_plan_confirmation(request, close_plan, [])

        self.assertNotEqual(first_token, second_token)
        self.assertNotIn(first_token, adapter.close_plan_confirmations)
        self.assertIn(second_token, adapter.close_plan_confirmations)
        request.close_plan_token = first_token
        with self.assertRaisesRegex(ValueError, 'expired or is no longer valid'):
            adapter._validate_close_plan_confirmation(request, close_plan, 'validate')

        request.close_plan_token = second_token
        record = adapter._validate_close_plan_confirmation(request, close_plan, 'validate')
        self.assertTrue(record['validated'])

    async def test_close_plan_cancel_is_scope_checked_and_idempotent(self):
        option_leg = self._build_close_leg('short_call', 1, 'C')
        option_leg.observed_bid = 2.0
        option_leg.observed_ask = 2.2
        adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            portfolio_positions_provider=lambda: [
                {'account': 'U1', 'secType': 'OPT', 'symbol': 'GLD', 'expDate': '20260618', 'right': 'C', 'strike': 415, 'position': -1},
            ],
        )
        request = ComboOrderRequest(
            group_id='group_cancel_confirmation',
            group_name='Cancel Confirmation',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            close_confirmation_target_mode='submit',
            legs=[option_leg],
        )
        close_plan = adapter._build_assignment_aware_close_plan(request)
        token, _record = adapter._register_close_plan_confirmation(request, close_plan, [])
        cancel_payload = {
            'groupId': request.group_id,
            'account': request.account,
            'confirmationTargetMode': 'submit',
            'closePlanToken': token,
        }

        mismatch = await adapter.cancel_close_plan_confirmation(object(), {
            **cancel_payload,
            'account': 'OTHER',
        })
        self.assertFalse(mismatch['revoked'])
        self.assertEqual(mismatch['status'], 'scope_mismatch')
        self.assertIn(token, adapter.close_plan_confirmations)

        cancelled = await adapter.cancel_close_plan_confirmation(object(), cancel_payload)
        self.assertTrue(cancelled['revoked'])
        self.assertEqual(cancelled['status'], 'cancelled')
        self.assertNotIn(token, adapter.close_plan_confirmations)

        duplicate = await adapter.cancel_close_plan_confirmation(object(), cancel_payload)
        self.assertFalse(duplicate['revoked'])
        self.assertEqual(duplicate['status'], 'already_inactive')

    async def test_validate_close_rejects_missing_tws_option_position(self):
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
        request = ComboOrderRequest(
            group_id='group_validate_missing',
            group_name='GLD Validate Missing',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            legs=[self._build_close_leg('assigned_put', 16, 'P')],
        )

        with self.assertRaisesRegex(ValueError, 'Close blocked.*No matching TWS portfolio position'):
            await adapter.validate_combo_order(object(), request)

    def test_close_plan_distinguishes_unready_snapshot_from_confirmed_empty_snapshot(self):
        request = ComboOrderRequest(
            group_id='group_snapshot_readiness',
            group_name='Snapshot Readiness',
            underlying_symbol='GLD',
            underlying_contract_month='',
            execution_mode='submit',
            account='U1',
            execution_intent='close',
            request_source='close_group',
            legs=[self._build_close_leg('missing_call', 1, 'C')],
        )
        unready_adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            portfolio_positions_provider=lambda: [],
            portfolio_positions_ready_provider=lambda: False,
        )
        with self.assertRaisesRegex(ValueError, 'positions are not ready'):
            unready_adapter._build_assignment_aware_close_plan(request)

        ready_adapter = IbkrExecutionAdapter(
            ib=_DummyIb(),
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
            portfolio_positions_provider=lambda: [],
            portfolio_positions_ready_provider=lambda: True,
        )
        with self.assertRaisesRegex(ValueError, 'Close blocked.*No matching TWS portfolio position'):
            ready_adapter._build_assignment_aware_close_plan(request)

    async def test_validate_checked_close_includes_live_option_and_underlying_legs(self):
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
                self._build_stock_close_leg('stock_leg', -1600),
            ],
        )

        request.close_confirmation_target_mode = 'submit'
        close_plan = adapter._build_assignment_aware_close_plan(request)
        token, _record = adapter._register_close_plan_confirmation(request, close_plan, [])
        request.close_plan_token = token
        result = await adapter.validate_combo_order(object(), request)

        self.assertTrue(result.valid)
        self.assertEqual(validated_leg_ids, ['stock_leg', 'short_call'])

    async def test_submit_closes_explicit_underlying_before_remaining_options(self):
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
                self._build_stock_close_leg('stock_leg', -1600),
            ],
        )
        self._authorize_close_request(adapter, request, [
            {
                'stage': 'underlying',
                'orderKind': 'underlying',
                'orderAction': 'SELL',
                'quantity': 1600,
                'limitPrice': 413.2,
                'legId': 'stock_leg',
            },
            {
                'stage': 'options',
                'orderKind': 'combo',
                'orderAction': 'BUY',
                'quantity': 16,
                'limitPrice': 2.1,
            },
        ])

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
        self.assertEqual(resolved_leg_ids, ['stock_leg', 'short_call'])
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
        self.assertEqual(result.preview.assignment_adjustments, [])

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
