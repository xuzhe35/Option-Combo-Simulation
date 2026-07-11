import asyncio
import pathlib
import sys
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


from trade_execution.engine import ExecutionEngine
from trade_execution.models import (
    HedgeOrderPreview,
    HedgeOrderRequest,
    HedgeSubmitResult,
    HedgeValidationResult,
)


class _HedgeAdapterStub:
    def __init__(self):
        self.calls = []

    async def validate_hedge_order(self, websocket, request):
        self.calls.append(("validate", websocket, request))
        return HedgeValidationResult(
            hedge_id=request.hedge_id,
            hedge_name=request.hedge_name,
            execution_mode=request.execution_mode,
            valid=True,
            sec_type=request.sec_type,
            symbol=request.symbol,
            local_symbol="SPY",
            con_id=756733,
        )

    async def preview_hedge_order(self, websocket, request):
        self.calls.append(("preview", websocket, request))
        return HedgeOrderPreview(
            hedge_id=request.hedge_id,
            hedge_name=request.hedge_name,
            sec_type=request.sec_type,
            symbol=request.symbol,
            local_symbol="SPY",
            exchange=request.exchange,
            currency=request.currency,
            order_action=request.order_action,
            quantity=request.quantity,
            order_type=request.order_type,
            limit_price=request.limit_price,
            time_in_force=request.time_in_force,
            execution_mode=request.execution_mode,
            account=request.account,
            request_source=request.request_source,
            projected_net_delta=request.projected_net_delta,
        )

    async def submit_hedge_order(self, websocket, request):
        self.calls.append(("submit", websocket, request))
        preview = HedgeOrderPreview(
            hedge_id=request.hedge_id,
            hedge_name=request.hedge_name,
            sec_type=request.sec_type,
            symbol=request.symbol,
            local_symbol="SPY",
            exchange=request.exchange,
            currency=request.currency,
            order_action=request.order_action,
            quantity=request.quantity,
            order_type=request.order_type,
            limit_price=request.limit_price,
            time_in_force=request.time_in_force,
            execution_mode=request.execution_mode,
            account=request.account,
            request_source=request.request_source,
        )
        return HedgeSubmitResult(
            preview=preview,
            order_id=1234,
            perm_id=5678,
            status="Submitted",
        )

    async def cancel_hedge_order(self, websocket, raw_data):
        self.calls.append(("cancel", websocket, raw_data))
        return {
            "hedgeId": raw_data.get("hedgeId"),
            "orderId": raw_data.get("orderId"),
            "status": "PendingCancel",
        }


class _ClosePlanAdapterStub:
    def __init__(self):
        self.calls = []

    async def cancel_close_plan_confirmation(self, websocket, raw_data):
        self.calls.append((websocket, raw_data))
        return {
            "revoked": True,
            "status": "cancelled",
        }


class HedgeOrderModelTests(unittest.TestCase):
    def test_parses_hedge_order_request_without_combo_fields(self):
        request = HedgeOrderRequest.from_payload({
            "hedgeId": "delta_spy",
            "hedgeName": "SPY Delta Hedge",
            "secType": "stk",
            "symbol": "spy",
            "exchange": "SMART",
            "currency": "USD",
            "orderAction": "buy",
            "quantity": "12",
            "orderType": "lmt",
            "limitPrice": "481.25",
            "timeInForce": "gtc",
            "executionMode": "preview",
            "account": "DU12345",
            "requestSource": "delta_hedge_manual",
            "currentNetDelta": "-592",
            "projectedNetDelta": "8",
        })

        self.assertEqual(request.hedge_id, "delta_spy")
        self.assertEqual(request.hedge_name, "SPY Delta Hedge")
        self.assertEqual(request.sec_type, "STK")
        self.assertEqual(request.symbol, "SPY")
        self.assertEqual(request.order_action, "BUY")
        self.assertEqual(request.quantity, 12)
        self.assertEqual(request.order_type, "LMT")
        self.assertEqual(request.limit_price, 481.25)
        self.assertEqual(request.time_in_force, "GTC")
        self.assertEqual(request.account, "DU12345")
        self.assertEqual(request.request_source, "delta_hedge_manual")
        self.assertEqual(request.current_net_delta, -592.0)
        self.assertEqual(request.projected_net_delta, 8.0)


class ExecutionEngineHedgeRoutingTests(unittest.TestCase):
    def test_combo_action_handler_does_not_handle_hedge_actions(self):
        engine = ExecutionEngine(_HedgeAdapterStub())
        payload = asyncio.run(engine.handle_combo_action(None, {
            "action": "preview_hedge_order",
            "hedgeId": "delta_spy",
        }))

        self.assertIsNone(payload)

    def test_routes_hedge_validation_to_parallel_adapter_method(self):
        adapter = _HedgeAdapterStub()
        engine = ExecutionEngine(adapter)
        websocket = object()

        payload = asyncio.run(engine.handle_hedge_action(websocket, {
            "action": "validate_hedge_order",
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
            "executionMode": "preview",
            "requestSource": "delta_hedge_manual",
        }))

        self.assertEqual(payload["action"], "hedge_order_validation_result")
        self.assertEqual(payload["hedgeId"], "delta_spy")
        self.assertEqual(payload["validation"]["symbol"], "SPY")
        self.assertEqual(adapter.calls[0][0], "validate")
        self.assertIs(adapter.calls[0][1], websocket)
        self.assertIsInstance(adapter.calls[0][2], HedgeOrderRequest)

    def test_routes_hedge_preview_and_submit_to_parallel_adapter_methods(self):
        adapter = _HedgeAdapterStub()
        engine = ExecutionEngine(adapter)
        base_payload = {
            "hedgeId": "delta_spy",
            "hedgeName": "SPY Delta Hedge",
            "secType": "STK",
            "symbol": "SPY",
            "exchange": "SMART",
            "currency": "USD",
            "orderAction": "BUY",
            "quantity": 5,
            "orderType": "LMT",
            "limitPrice": 480.5,
            "executionMode": "submit",
            "account": "DU12345",
            "requestSource": "delta_hedge_manual",
        }

        preview_payload = asyncio.run(engine.handle_hedge_action(None, {
            **base_payload,
            "action": "preview_hedge_order",
        }))
        submit_payload = asyncio.run(engine.handle_hedge_action(None, {
            **base_payload,
            "action": "submit_hedge_order",
            "executionPlanToken": preview_payload["preview"]["executionPlanToken"],
        }))

        self.assertEqual(preview_payload["action"], "hedge_order_preview_result")
        self.assertEqual(preview_payload["preview"]["orderAction"], "BUY")
        self.assertEqual(submit_payload["action"], "hedge_order_submit_result")
        self.assertEqual(submit_payload["order"]["orderId"], 1234)
        self.assertEqual([call[0] for call in adapter.calls], ["preview", "submit"])

    def test_hedge_authorization_binds_broker_quantized_preview_price(self):
        class _QuantizingHedgeAdapter(_HedgeAdapterStub):
            async def preview_hedge_order(self, websocket, request):
                preview = await super().preview_hedge_order(websocket, request)
                preview.limit_price = 5125.25
                preview.price_increment = 0.25
                return preview

        adapter = _QuantizingHedgeAdapter()
        engine = ExecutionEngine(adapter)
        websocket = object()
        request = {
            "hedgeId": "delta_es",
            "hedgeName": "ES Delta Hedge",
            "secType": "FUT",
            "symbol": "ES",
            "exchange": "CME",
            "currency": "USD",
            "contractMonth": "202609",
            "orderAction": "BUY",
            "quantity": 1,
            "orderType": "LMT",
            "limitPrice": 5125.13,
            "executionMode": "submit",
            "account": "DU12345",
        }

        preview = asyncio.run(engine.handle_hedge_action(
            websocket, {**request, "action": "preview_hedge_order"}
        ))
        submit = asyncio.run(engine.handle_hedge_action(websocket, {
            **request,
            "action": "submit_hedge_order",
            "limitPrice": preview["preview"]["limitPrice"],
            "executionPlanToken": preview["preview"]["executionPlanToken"],
        }))

        self.assertEqual(preview["preview"]["limitPrice"], 5125.25)
        self.assertEqual(submit["action"], "hedge_order_submit_result")
        self.assertEqual(adapter.calls[-1][2].limit_price, 5125.25)

    def test_hedge_submit_calls_hedge_tracking_callback(self):
        adapter = _HedgeAdapterStub()
        callback_calls = []
        engine = ExecutionEngine(
            adapter,
            on_hedge_submit_result=lambda websocket, request, result: callback_calls.append(
                (websocket, request, result)
            ),
        )
        websocket = object()

        request = {
            "hedgeId": "delta_spy",
            "hedgeName": "SPY Delta Hedge",
            "secType": "STK",
            "symbol": "SPY",
            "exchange": "SMART",
            "currency": "USD",
            "orderAction": "SELL",
            "quantity": 4,
            "orderType": "LMT",
            "limitPrice": 481.25,
            "executionMode": "submit",
            "account": "DU12345",
            "requestSource": "delta_hedge_manual",
        }
        preview = asyncio.run(engine.handle_hedge_action(websocket, {**request, "action": "preview_hedge_order"}))
        payload = asyncio.run(engine.handle_hedge_action(websocket, {
            **request,
            "action": "submit_hedge_order",
            "executionPlanToken": preview["preview"]["executionPlanToken"],
        }))

        self.assertEqual(payload["action"], "hedge_order_submit_result")
        self.assertEqual(len(callback_calls), 1)
        self.assertIs(callback_calls[0][0], websocket)
        self.assertIsInstance(callback_calls[0][1], HedgeOrderRequest)
        self.assertIsInstance(callback_calls[0][2], HedgeSubmitResult)
        self.assertEqual(callback_calls[0][1].hedge_id, "delta_spy")
        self.assertEqual(callback_calls[0][2].order_id, 1234)

    def test_hedge_submit_rejects_when_active_hedge_order_exists(self):
        adapter = _HedgeAdapterStub()
        websocket = object()
        engine = ExecutionEngine(
            adapter,
            has_active_hedge_order=lambda ws, request: (
                "Active hedge order already exists."
                if ws is websocket and request.hedge_id == "delta_spy"
                else False
            ),
        )

        request = {
            "hedgeId": "delta_spy",
            "hedgeName": "SPY Delta Hedge",
            "secType": "STK",
            "symbol": "SPY",
            "exchange": "SMART",
            "currency": "USD",
            "orderAction": "SELL",
            "quantity": 4,
            "orderType": "LMT",
            "limitPrice": 481.25,
            "executionMode": "submit",
            "account": "DU12345",
            "requestSource": "delta_hedge_auto_submit",
        }
        preview = asyncio.run(engine.handle_hedge_action(websocket, {**request, "action": "preview_hedge_order"}))
        payload = asyncio.run(engine.handle_hedge_action(websocket, {
            **request,
            "action": "submit_hedge_order",
            "executionPlanToken": preview["preview"]["executionPlanToken"],
        }))

        self.assertEqual(payload["action"], "hedge_order_error")
        self.assertEqual(payload["hedgeId"], "delta_spy")
        self.assertEqual(payload["requestAction"], "submit_hedge_order")
        self.assertEqual(payload["requestSource"], "delta_hedge_auto_submit")
        self.assertIn("Active hedge order", payload["message"])
        self.assertEqual([call[0] for call in adapter.calls], ["preview"])

    def test_routes_hedge_cancel_without_parsing_order_request(self):
        adapter = _HedgeAdapterStub()
        engine = ExecutionEngine(adapter)

        payload = asyncio.run(engine.handle_hedge_action(None, {
            "action": "cancel_hedge_order",
            "hedgeId": "delta_spy",
            "orderId": 1234,
        }))

        self.assertEqual(payload["action"], "hedge_order_cancel_result")
        self.assertEqual(payload["hedgeId"], "delta_spy")
        self.assertEqual(payload["orderStatus"]["status"], "PendingCancel")
        self.assertEqual(adapter.calls[0][0], "cancel")


class ExecutionEngineClosePlanRoutingTests(unittest.TestCase):
    def test_routes_close_plan_cancel_without_parsing_combo_request(self):
        adapter = _ClosePlanAdapterStub()
        engine = ExecutionEngine(adapter)
        websocket = object()

        payload = asyncio.run(engine.handle_combo_action(websocket, {
            "action": "cancel_close_plan",
            "groupId": "group_close",
            "account": "DU12345",
            "confirmationTargetMode": "submit",
            "closePlanToken": "one-time-token",
        }))

        self.assertEqual(payload["action"], "combo_order_close_plan_cancel_result")
        self.assertEqual(payload["groupId"], "group_close")
        self.assertTrue(payload["closePlan"]["revoked"])
        self.assertEqual(payload["closePlan"]["status"], "cancelled")
        self.assertIs(adapter.calls[0][0], websocket)
        self.assertEqual(adapter.calls[0][1]["closePlanToken"], "one-time-token")


if __name__ == "__main__":
    unittest.main()
