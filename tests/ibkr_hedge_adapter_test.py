import asyncio
import pathlib
import sys
import types
import unittest
from types import SimpleNamespace


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


if "ib_async" not in sys.modules:
    ib_async = types.ModuleType("ib_async")

    class _SimpleIbObject:
        def __init__(self, *args, **kwargs):
            positional_fields = ("symbol", "exchange", "currency")
            for key, value in zip(positional_fields, args):
                setattr(self, key, value)
            for key, value in kwargs.items():
                setattr(self, key, value)

    ib_async.ComboLeg = _SimpleIbObject
    ib_async.Contract = _SimpleIbObject
    ib_async.Order = _SimpleIbObject
    ib_async.Stock = _SimpleIbObject
    ib_async.TagValue = _SimpleIbObject
    sys.modules["ib_async"] = ib_async


from trade_execution.adapters.ibkr import IbkrExecutionAdapter
from trade_execution.models import HedgeOrderRequest


class _DummyEvent:
    def __iadd__(self, handler):
        self.handler = handler
        return self


class _FakeIb:
    def __init__(self):
        self.orderStatusEvent = _DummyEvent()
        self.connected = True
        self.qualified_contracts = []
        self.placed_orders = []
        self.cancelled_orders = []

    def isConnected(self):
        return self.connected

    async def qualifyContractsAsync(self, contract):
        self.qualified_contracts.append(contract)
        if not getattr(contract, "conId", None):
            contract.conId = 1000 + len(self.qualified_contracts)
        if not getattr(contract, "localSymbol", None):
            contract.localSymbol = getattr(contract, "symbol", "")
        return [contract]

    def placeOrder(self, contract, order):
        order.orderId = 7000 + len(self.placed_orders)
        trade = SimpleNamespace(
            contract=contract,
            order=order,
            orderStatus=SimpleNamespace(
                permId=9000 + len(self.placed_orders),
                status="Submitted",
                filled=0.0,
                remaining=float(getattr(order, "totalQuantity", 0) or 0),
                avgFillPrice=0.0,
                lastFillPrice=0.0,
                whyHeld="",
                mktCapPrice=0.0,
            ),
            log=[],
            advancedError="",
        )
        self.placed_orders.append((contract, order, trade))
        return trade

    def cancelOrder(self, order):
        self.cancelled_orders.append(order)


class _MarketRuleFakeIb(_FakeIb):
    """Fake IB that exposes the contract-details / market-rule API so the hedge
    path can resolve a real price increment (e.g. ES futures 0.25)."""

    async def reqContractDetailsAsync(self, contract):
        return [SimpleNamespace(
            minTick=0.25,
            validExchanges="CME",
            marketRuleIds="67",
            contract=SimpleNamespace(exchange="CME"),
        )]

    async def reqMarketRuleAsync(self, market_rule_id):
        return [SimpleNamespace(lowEdge=0, increment=0.25)]


class IbkrHedgeAdapterTests(unittest.TestCase):
    def setUp(self):
        self.ib = _FakeIb()
        self.adapter = IbkrExecutionAdapter(
            ib=self.ib,
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
        )

    def test_validate_hedge_order_qualifies_stock_contract(self):
        request = HedgeOrderRequest.from_payload({
            "hedgeId": "delta_spy",
            "hedgeName": "SPY Delta Hedge",
            "secType": "STK",
            "symbol": "SPY",
            "exchange": "SMART",
            "currency": "USD",
            "orderAction": "BUY",
            "quantity": 12,
            "orderType": "LMT",
            "limitPrice": 481.25,
        })

        validation = self._run(self.adapter.validate_hedge_order(None, request))

        self.assertTrue(validation.valid)
        self.assertEqual(validation.hedge_id, "delta_spy")
        self.assertEqual(validation.sec_type, "STK")
        self.assertEqual(validation.symbol, "SPY")
        self.assertEqual(validation.con_id, 1001)
        self.assertEqual(getattr(self.ib.qualified_contracts[0], "secType", ""), "STK")

    def test_preview_hedge_order_builds_single_lmt_order_without_bag_contract(self):
        request = HedgeOrderRequest.from_payload({
            "hedgeId": "delta_spy",
            "hedgeName": "SPY Delta Hedge",
            "secType": "STK",
            "symbol": "SPY",
            "exchange": "SMART",
            "currency": "USD",
            "orderAction": "BUY",
            "quantity": 12,
            "orderType": "LMT",
            "limitPrice": 481.25,
            "account": "DU12345",
        })

        preview = self._run(self.adapter.preview_hedge_order(None, request))

        self.assertEqual(preview.sec_type, "STK")
        self.assertEqual(preview.symbol, "SPY")
        self.assertEqual(preview.order_action, "BUY")
        self.assertEqual(preview.quantity, 12)
        self.assertEqual(preview.order_type, "LMT")
        self.assertEqual(preview.limit_price, 481.25)
        self.assertEqual(self.ib.placed_orders, [])
        self.assertNotEqual(getattr(self.ib.qualified_contracts[0], "secType", ""), "BAG")

    def test_submit_hedge_order_places_single_future_order_without_bag_contract(self):
        request = HedgeOrderRequest.from_payload({
            "hedgeId": "delta_es",
            "hedgeName": "ES Delta Hedge",
            "secType": "FUT",
            "symbol": "ES",
            "exchange": "CME",
            "currency": "USD",
            "contractMonth": "202606",
            "multiplier": "50",
            "orderAction": "SELL",
            "quantity": 1,
            "orderType": "LMT",
            "limitPrice": 5125.25,
            "account": "DU12345",
        })

        result = self._run(self.adapter.submit_hedge_order(None, request))

        self.assertEqual(result.status, "Submitted")
        self.assertEqual(result.order_id, 7000)
        self.assertEqual(result.perm_id, 9000)
        contract, order, _trade = self.ib.placed_orders[0]
        self.assertEqual(getattr(contract, "secType", ""), "FUT")
        self.assertNotEqual(getattr(contract, "secType", ""), "BAG")
        self.assertEqual(getattr(contract, "symbol", ""), "ES")
        self.assertEqual(getattr(contract, "lastTradeDateOrContractMonth", ""), "202606")
        self.assertEqual(order.action, "SELL")
        self.assertEqual(order.orderType, "LMT")
        self.assertEqual(order.totalQuantity, 1)
        self.assertEqual(order.lmtPrice, 5125.25)
        self.assertEqual(order.account, "DU12345")

    def test_submit_hedge_order_requires_explicit_account(self):
        request = HedgeOrderRequest.from_payload({
            "hedgeId": "delta_spy",
            "hedgeName": "SPY Delta Hedge",
            "secType": "STK",
            "symbol": "SPY",
            "exchange": "SMART",
            "currency": "USD",
            "orderAction": "BUY",
            "quantity": 1,
            "orderType": "LMT",
            "limitPrice": 481.25,
        })

        with self.assertRaisesRegex(ValueError, "account"):
            self._run(self.adapter.submit_hedge_order(None, request))

        self.assertEqual(self.ib.placed_orders, [])

    def test_cancel_hedge_order_cancels_submitted_single_order(self):
        websocket = object()
        request = HedgeOrderRequest.from_payload({
            "hedgeId": "delta_spy",
            "hedgeName": "SPY Delta Hedge",
            "secType": "STK",
            "symbol": "SPY",
            "exchange": "SMART",
            "currency": "USD",
            "orderAction": "SELL",
            "quantity": 3,
            "orderType": "LMT",
            "limitPrice": 481.25,
            "account": "DU12345",
            "requestSource": "delta_hedge_manual",
        })
        result = self._run(self.adapter.submit_hedge_order(websocket, request))

        snapshot = self._run(self.adapter.cancel_hedge_order(websocket, {
            "hedgeId": "delta_spy",
            "orderId": result.order_id,
        }))

        self.assertEqual(snapshot["hedgeId"], "delta_spy")
        self.assertEqual(snapshot["orderId"], 7000)
        self.assertEqual(snapshot["permId"], 9000)
        self.assertEqual(snapshot["status"], "PendingCancel")
        self.assertTrue(snapshot["cancelRequested"])
        self.assertEqual(snapshot["secType"], "STK")
        self.assertEqual(snapshot["symbol"], "SPY")
        self.assertEqual(len(self.ib.cancelled_orders), 1)
        self.assertIs(self.ib.cancelled_orders[0], self.ib.placed_orders[0][1])

    def test_cancel_hedge_order_refuses_different_websocket(self):
        request = HedgeOrderRequest.from_payload({
            "hedgeId": "delta_spy",
            "hedgeName": "SPY Delta Hedge",
            "secType": "STK",
            "symbol": "SPY",
            "exchange": "SMART",
            "currency": "USD",
            "orderAction": "SELL",
            "quantity": 3,
            "orderType": "LMT",
            "limitPrice": 481.25,
            "account": "DU12345",
        })
        result = self._run(self.adapter.submit_hedge_order(object(), request))

        with self.assertRaisesRegex(ValueError, "different session"):
            self._run(self.adapter.cancel_hedge_order(object(), {
                "hedgeId": "delta_spy",
                "orderId": result.order_id,
            }))

        self.assertEqual(self.ib.cancelled_orders, [])

    def test_cancel_hedge_order_refuses_terminal_status_after_status_event(self):
        websocket = object()
        request = HedgeOrderRequest.from_payload({
            "hedgeId": "delta_spy",
            "hedgeName": "SPY Delta Hedge",
            "secType": "STK",
            "symbol": "SPY",
            "exchange": "SMART",
            "currency": "USD",
            "orderAction": "SELL",
            "quantity": 3,
            "orderType": "LMT",
            "limitPrice": 481.25,
            "account": "DU12345",
        })
        result = self._run(self.adapter.submit_hedge_order(websocket, request))
        _contract, _order, trade = self.ib.placed_orders[0]
        trade.orderStatus.status = "Filled"
        trade.orderStatus.filled = 3.0
        trade.orderStatus.remaining = 0.0
        self.adapter._on_hedge_order_status(trade)

        with self.assertRaisesRegex(ValueError, "terminal broker status Filled"):
            self._run(self.adapter.cancel_hedge_order(websocket, {
                "hedgeId": "delta_spy",
                "orderId": result.order_id,
            }))

        self.assertEqual(self.ib.cancelled_orders, [])

    def test_hedge_lmt_snaps_to_market_rule_tick(self):
        # ES futures trade in 0.25 ticks; a hedge limit off that grid must be
        # snapped via the same market-rule resolution the combo path uses, not
        # left at the client-provided (possibly 0.01-rounded) value.
        self.ib = _MarketRuleFakeIb()
        self.adapter = IbkrExecutionAdapter(
            ib=self.ib,
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
        )
        request = HedgeOrderRequest.from_payload({
            "hedgeId": "delta_es",
            "hedgeName": "ES Delta Hedge",
            "secType": "FUT",
            "symbol": "ES",
            "exchange": "CME",
            "currency": "USD",
            "contractMonth": "202606",
            "multiplier": "50",
            "orderAction": "BUY",
            "quantity": 1,
            "orderType": "LMT",
            "limitPrice": 5125.13,
            "account": "DU12345",
        })

        preview = self._run(self.adapter.preview_hedge_order(None, request))

        # BUY rounds up to the next valid 0.25 tick (5125.13 -> 5125.25), and the
        # resolved increment is surfaced on the preview payload.
        self.assertEqual(preview.price_increment, 0.25)
        self.assertEqual(preview.limit_price, 5125.25)
        self.assertEqual(preview.to_payload()["priceIncrement"], 0.25)

    def _run(self, awaitable):
        import asyncio

        return asyncio.run(awaitable)


class IbkrHedgeRecoverySafetyTests(unittest.IsolatedAsyncioTestCase):
    def _build_adapter(self, ib):
        return IbkrExecutionAdapter(
            ib=ib,
            client_subscriptions={},
            qualified_underlyings={},
            supported_live_families={},
            index_exchange_fallbacks={},
        )

    def _build_market_submit_request(self, hedge_id):
        return HedgeOrderRequest.from_payload({
            "hedgeId": hedge_id,
            "hedgeName": "Recovery Safety Hedge",
            "secType": "STK",
            "symbol": "SPY",
            "exchange": "SMART",
            "currency": "USD",
            "orderAction": "SELL",
            "quantity": 1,
            "orderType": "MKT",
            "account": "TEST_ACCOUNT",
            "requestSource": "delta_hedge_manual",
        })

    async def test_submit_entered_during_recovery_stops_before_qualification(self):
        ib = _FakeIb()
        adapter = self._build_adapter(ib)
        await adapter.pause_managed_for_ib_recovery()

        with self.assertRaisesRegex(ConnectionError, "recovery is still in progress"):
            await adapter.submit_hedge_order(
                object(),
                self._build_market_submit_request("recovery_in_progress_submit"),
            )

        self.assertEqual(ib.qualified_contracts, [])
        self.assertEqual(ib.placed_orders, [])

    async def test_cancel_entered_during_recovery_stops_before_context_processing(self):
        ib = _FakeIb()
        adapter = self._build_adapter(ib)
        websocket = object()
        result = await adapter.submit_hedge_order(
            websocket,
            self._build_market_submit_request("recovery_in_progress_cancel"),
        )
        context = adapter._resolve_hedge_order_tracking(result.order_id, result.perm_id)
        self.assertIsNotNone(context)
        await adapter.pause_managed_for_ib_recovery()

        def unexpected_context_resolution(_order_id, _perm_id):
            raise AssertionError("recovery entry gate must run before hedge-context processing")

        adapter._resolve_hedge_order_tracking = unexpected_context_resolution
        with self.assertRaisesRegex(ConnectionError, "recovery is still in progress"):
            await adapter.cancel_hedge_order(websocket, {
                "hedgeId": "recovery_in_progress_cancel",
                "orderId": result.order_id,
                "permId": result.perm_id,
            })

        self.assertEqual(ib.cancelled_orders, [])
        self.assertEqual(context["status"], "Submitted")
        self.assertFalse(context["cancelRequested"])

    async def test_completed_recovery_during_hedge_qualification_blocks_placement(self):
        ib = _FakeIb()
        adapter = self._build_adapter(ib)
        qualification_started = asyncio.Event()
        release_qualification = asyncio.Event()
        qualify_contract = ib.qualifyContractsAsync

        async def blocked_qualification(contract):
            qualification_started.set()
            await release_qualification.wait()
            return await qualify_contract(contract)

        ib.qualifyContractsAsync = blocked_qualification
        submit_task = asyncio.create_task(adapter.submit_hedge_order(
            object(),
            self._build_market_submit_request("recovery_build"),
        ))

        await qualification_started.wait()
        await adapter.pause_managed_for_ib_recovery()
        adapter.complete_ib_recovery()
        release_qualification.set()

        with self.assertRaisesRegex(ConnectionError, "action was in flight"):
            await submit_task
        self.assertEqual(ib.placed_orders, [])

    async def test_stale_submitted_hedge_cannot_be_cancelled_after_recovery(self):
        ib = _FakeIb()
        adapter = self._build_adapter(ib)
        websocket = object()
        result = await adapter.submit_hedge_order(
            websocket,
            self._build_market_submit_request("recovery_cancel"),
        )
        context = adapter._resolve_hedge_order_tracking(result.order_id, result.perm_id)
        self.assertIsNotNone(context)
        self.assertEqual(context["status"], "Submitted")
        self.assertFalse(context["cancelRequested"])

        await adapter.pause_managed_for_ib_recovery()
        adapter.complete_ib_recovery()

        with self.assertRaisesRegex(ConnectionError, "manually in TWS"):
            await adapter.cancel_hedge_order(websocket, {
                "hedgeId": "recovery_cancel",
                "orderId": result.order_id,
                "permId": result.perm_id,
            })

        self.assertEqual(ib.cancelled_orders, [])
        self.assertEqual(context["status"], "Submitted")
        self.assertFalse(context["cancelRequested"])


if __name__ == "__main__":
    unittest.main()
