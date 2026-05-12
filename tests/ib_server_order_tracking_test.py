import asyncio
import json
import pathlib
import sys
import unittest
from types import SimpleNamespace


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


from ib_server_order_tracking import (  # noqa: E402
    build_active_hedge_orders_snapshot,
    build_combo_order_error_handler,
    build_combo_order_exec_details_handler,
    build_combo_order_status_handler,
    build_hedge_order_exec_details_handler,
    build_hedge_order_status_handler,
)


class _ExecutionEngineStub:
    def __init__(self):
        self.snapshots = {}

    def get_managed_order_snapshot(self, order_id, perm_id):
        return self.snapshots.get((order_id, perm_id))


class IbServerOrderTrackingTests(unittest.IsolatedAsyncioTestCase):
    def _build_env(self):
        sent_messages = []
        execution_engine = _ExecutionEngineStub()

        async def send_message_safe(websocket, message):
            sent_messages.append((websocket, json.loads(message)))

        env = {
            'combo_order_tracking_by_order_id': {},
            'combo_order_tracking_by_perm_id': {},
            'hedge_order_tracking_by_order_id': {},
            'hedge_order_tracking_by_perm_id': {},
            'execution_engine': execution_engine,
            'send_message_safe': send_message_safe,
        }
        return env, sent_messages, execution_engine

    async def test_combo_status_update_merges_managed_snapshot(self):
        env, sent_messages, execution_engine = self._build_env()
        websocket = object()
        tracking = {
            'websocket': websocket,
            'groupId': 'group_1',
            'groupName': 'Combo 1',
            'executionMode': 'submit',
            'executionIntent': 'open',
            'requestSource': 'trial_trigger',
            'orderId': 501,
            'permId': 601,
            'status': 'PreSubmitted',
        }
        env['combo_order_tracking_by_order_id'][501] = tracking
        env['combo_order_tracking_by_perm_id'][601] = tracking
        execution_engine.snapshots[(501, 601)] = {
            'managedMode': True,
            'managedState': 'watching',
            'workingLimitPrice': 2.25,
        }
        trade = SimpleNamespace(
            order=SimpleNamespace(orderId=501, account='F1234567'),
            orderStatus=SimpleNamespace(
                permId=601,
                status='Submitted',
                filled=0,
                remaining=1,
                avgFillPrice=0,
                lastFillPrice=0,
                whyHeld='',
                mktCapPrice=0,
            ),
            log=[SimpleNamespace(message='Watching broker status', errorCode=None)],
            advancedError='',
        )

        handler = build_combo_order_status_handler(env)
        handler(trade)
        await asyncio.sleep(0)

        self.assertEqual(len(sent_messages), 1)
        payload = sent_messages[0][1]
        self.assertEqual(payload['action'], 'combo_order_status_update')
        self.assertEqual(payload['orderStatus']['managedMode'], True)
        self.assertEqual(payload['orderStatus']['managedState'], 'watching')
        self.assertEqual(payload['orderStatus']['workingLimitPrice'], 2.25)
        self.assertEqual(payload['orderStatus']['statusMessage'], 'Watching broker status')
        self.assertEqual(tracking['account'], 'F1234567')
        self.assertEqual(tracking['status'], 'Submitted')

    async def test_combo_error_writes_status_message_and_infers_status(self):
        env, sent_messages, _execution_engine = self._build_env()
        websocket = object()
        trade = SimpleNamespace(
            order=SimpleNamespace(orderId=712, account='F1234567'),
            orderStatus=SimpleNamespace(
                permId=812,
                status='Submitted',
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
        tracking = {
            'websocket': websocket,
            'groupId': 'group_error',
            'groupName': 'Error Combo',
            'executionMode': 'submit',
            'executionIntent': 'open',
            'requestSource': 'trial_trigger',
            'orderId': 712,
            'permId': 812,
            'status': 'Submitted',
            'trade': trade,
        }
        env['combo_order_tracking_by_order_id'][712] = tracking
        env['combo_order_tracking_by_perm_id'][812] = tracking

        handler = build_combo_order_error_handler(env)
        handler('712', 201, 'Order rejected for available funds', None)
        await asyncio.sleep(0)

        self.assertEqual(len(sent_messages), 1)
        payload = sent_messages[0][1]
        self.assertEqual(payload['orderStatus']['status'], 'Inactive')
        self.assertEqual(payload['orderStatus']['statusMessage'], 'IB 201: Order rejected for available funds')
        self.assertEqual(tracking['status'], 'Inactive')

    async def test_combo_fill_cost_updates_only_once_per_exec_id(self):
        env, sent_messages, _execution_engine = self._build_env()
        websocket = object()
        tracking = {
            'websocket': websocket,
            'groupId': 'group_fill',
            'groupName': 'Fill Combo',
            'executionMode': 'submit',
            'executionIntent': 'open',
            'requestSource': 'trial_trigger',
            'orderId': 900,
            'permId': 901,
            'legs': [
                {
                    'id': 'leg_call',
                    'conId': 101,
                    'localSymbol': 'SPY  240621C00500000',
                    'symbol': 'SPY',
                    'secType': 'OPT',
                    'right': 'C',
                    'strike': 500,
                    'expDate': '20240621',
                    'targetPosition': 1,
                    'expectedExecutionSide': 'BUY',
                },
            ],
            'fillTotals': {},
            'seenExecIds': set(),
        }
        env['combo_order_tracking_by_order_id'][900] = tracking
        env['combo_order_tracking_by_perm_id'][901] = tracking

        trade = SimpleNamespace(
            order=SimpleNamespace(orderId=900),
            orderStatus=SimpleNamespace(permId=901),
            contract=SimpleNamespace(secType='OPT', conId=101),
        )
        fill = SimpleNamespace(
            execution=SimpleNamespace(orderId=900, permId=901, execId='fill-1', shares=2, price=1.25, side='BOT'),
            contract=SimpleNamespace(secType='OPT', conId=101),
        )

        handler = build_combo_order_exec_details_handler(env)
        handler(trade, fill)
        handler(trade, fill)
        await asyncio.sleep(0)

        self.assertEqual(len(sent_messages), 1)
        payload = sent_messages[0][1]
        self.assertEqual(payload['action'], 'combo_order_fill_cost_update')
        self.assertEqual(len(payload['orderFill']['legs']), 1)
        self.assertEqual(payload['orderFill']['legs'][0]['avgFillPrice'], 1.25)
        self.assertEqual(tracking['fillTotals']['leg_call']['filledQuantity'], 2.0)

    async def test_hedge_status_update_preserves_metadata_fields(self):
        env, sent_messages, _execution_engine = self._build_env()
        websocket = object()
        tracking = {
            'websocket': websocket,
            'hedgeId': 'delta_spy',
            'hedgeName': 'SPY Hedge',
            'account': 'F7654321',
            'executionMode': 'submit',
            'requestSource': 'delta_hedge_manual_submit',
            'orderId': 300,
            'permId': 301,
            'secType': 'STK',
            'symbol': 'SPY',
            'localSymbol': 'SPY',
            'exchange': 'SMART',
            'currency': 'USD',
            'conId': 756733,
            'orderAction': 'SELL',
            'quantity': 3,
            'orderType': 'LMT',
            'limitPrice': 502.15,
            'timeInForce': 'DAY',
            'currentNetDelta': 145.0,
            'projectedNetDelta': 5.0,
            'targetLower': -10.0,
            'targetUpper': 10.0,
        }
        env['hedge_order_tracking_by_order_id'][300] = tracking
        env['hedge_order_tracking_by_perm_id'][301] = tracking
        trade = SimpleNamespace(
            order=SimpleNamespace(orderId=300, account='F7654321', action='SELL', totalQuantity=3, orderType='LMT', lmtPrice=502.15, tif='DAY'),
            orderStatus=SimpleNamespace(
                permId=301,
                status='Submitted',
                filled=1,
                remaining=2,
                avgFillPrice=502.10,
                lastFillPrice=502.10,
                whyHeld='',
                mktCapPrice=0,
            ),
            log=[SimpleNamespace(message='Watching hedge order', errorCode=None)],
            advancedError='',
        )

        handler = build_hedge_order_status_handler(env)
        handler(trade)
        await asyncio.sleep(0)

        self.assertEqual(len(sent_messages), 1)
        payload = sent_messages[0][1]
        self.assertEqual(payload['orderStatus']['hedgeId'], 'delta_spy')
        self.assertEqual(payload['orderStatus']['symbol'], 'SPY')
        self.assertEqual(payload['orderStatus']['currentNetDelta'], 145.0)
        self.assertEqual(payload['orderStatus']['targetUpper'], 10.0)
        self.assertEqual(payload['orderStatus']['filled'], 1)

    async def test_hedge_fill_update_accumulates_fill_totals(self):
        env, sent_messages, _execution_engine = self._build_env()
        websocket = object()
        tracking = {
            'websocket': websocket,
            'hedgeId': 'delta_es',
            'hedgeName': 'ES Hedge',
            'account': 'DU123',
            'executionMode': 'submit',
            'requestSource': 'delta_hedge_manual_submit',
            'orderId': 450,
            'permId': 451,
            'symbol': 'ES',
            'localSymbol': 'ESH6',
            'secType': 'FUT',
            'exchange': 'CME',
            'currency': 'USD',
            'orderAction': 'SELL',
            'quantity': 4,
            'orderType': 'LMT',
            'limitPrice': 5300.0,
            'timeInForce': 'DAY',
            'fillTotals': {},
            'seenExecIds': set(),
        }
        env['hedge_order_tracking_by_order_id'][450] = tracking
        env['hedge_order_tracking_by_perm_id'][451] = tracking
        trade = SimpleNamespace(
            order=SimpleNamespace(orderId=450),
            orderStatus=SimpleNamespace(permId=451),
            contract=SimpleNamespace(secType='FUT', conId=5001, localSymbol='ESH6', symbol='ES', exchange='CME', currency='USD'),
        )
        fill_one = SimpleNamespace(
            execution=SimpleNamespace(orderId=450, permId=451, execId='hedge-fill-1', shares=3, price=5300.0, side='SLD'),
            contract=SimpleNamespace(secType='FUT', conId=5001, localSymbol='ESH6', symbol='ES', exchange='CME', currency='USD'),
        )
        fill_two = SimpleNamespace(
            execution=SimpleNamespace(orderId=450, permId=451, execId='hedge-fill-2', shares=1, price=5310.0, side='SLD'),
            contract=SimpleNamespace(secType='FUT', conId=5001, localSymbol='ESH6', symbol='ES', exchange='CME', currency='USD'),
        )

        handler = build_hedge_order_exec_details_handler(env)
        handler(trade, fill_one)
        handler(trade, fill_two)
        await asyncio.sleep(0)

        self.assertEqual(len(sent_messages), 2)
        final_payload = sent_messages[-1][1]
        self.assertEqual(final_payload['action'], 'hedge_order_fill_update')
        self.assertEqual(final_payload['orderFill']['filledQuantity'], 4.0)
        self.assertEqual(final_payload['orderFill']['avgFillPrice'], 5302.5)
        self.assertEqual(tracking['remaining'], 0.0)

    def test_active_hedge_snapshot_filters_terminal_orders_and_rebinds_websocket(self):
        env, _sent_messages, _execution_engine = self._build_env()
        old_websocket = object()
        new_websocket = object()
        active_tracking = {
            'websocket': old_websocket,
            'hedgeId': 'delta_spy',
            'hedgeName': 'SPY Hedge',
            'account': 'ACC-1',
            'executionMode': 'submit',
            'requestSource': 'delta_hedge_manual_submit',
            'orderId': 700,
            'permId': 701,
            'status': 'Submitted',
            'symbol': 'SPY',
            'localSymbol': 'SPY',
            'secType': 'STK',
            'exchange': 'SMART',
            'currency': 'USD',
            'trade': SimpleNamespace(
                order=SimpleNamespace(orderId=700, account='ACC-1'),
                orderStatus=SimpleNamespace(permId=701, status='Submitted', filled=0, remaining=1, avgFillPrice=0, lastFillPrice=0, whyHeld='', mktCapPrice=0),
            ),
        }
        terminal_tracking = {
            'websocket': old_websocket,
            'hedgeId': 'delta_spy',
            'hedgeName': 'SPY Hedge',
            'account': 'ACC-1',
            'executionMode': 'submit',
            'requestSource': 'delta_hedge_manual_submit',
            'orderId': 702,
            'permId': 703,
            'status': 'Filled',
            'symbol': 'SPY',
        }
        env['hedge_order_tracking_by_order_id'][700] = active_tracking
        env['hedge_order_tracking_by_perm_id'][701] = active_tracking
        env['hedge_order_tracking_by_order_id'][702] = terminal_tracking
        env['hedge_order_tracking_by_perm_id'][703] = terminal_tracking

        payload = build_active_hedge_orders_snapshot(
            env,
            new_websocket,
            {'hedgeId': 'delta_spy', 'account': 'ACC-1'},
        )

        self.assertEqual(payload['action'], 'active_hedge_orders_snapshot')
        self.assertEqual(len(payload['orders']), 1)
        self.assertEqual(payload['orders'][0]['orderId'], 700)
        self.assertEqual(active_tracking['websocket'], new_websocket)
