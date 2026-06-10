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
    build_active_combo_orders_snapshot,
    build_active_hedge_orders_snapshot,
    build_combo_order_error_handler,
    build_combo_order_exec_details_handler,
    build_combo_order_status_handler,
    build_hedge_order_exec_details_handler,
    build_hedge_order_status_handler,
    is_terminal_combo_tracking,
    upsert_combo_order_tracking,
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

    async def test_combo_fill_recorded_while_tracking_orphaned(self):
        env, sent_messages, _execution_engine = self._build_env()
        tracking = {
            'websocket': None,
            'groupId': 'group_orphan',
            'groupName': 'Orphan Combo',
            'executionMode': 'submit',
            'executionIntent': 'open',
            'requestSource': 'trial_trigger',
            'orderId': 910,
            'permId': 911,
            'legs': [
                {
                    'id': 'leg_call',
                    'conId': 111,
                    'localSymbol': 'SPY  240621C00500000',
                    'symbol': 'SPY',
                    'secType': 'OPT',
                    'right': 'C',
                    'strike': 500,
                    'expDate': '20240621',
                    'targetPosition': 1,
                    'expectedExecutionSide': 'BOT',
                },
            ],
            'fillTotals': {},
            'seenExecIds': set(),
        }
        env['combo_order_tracking_by_order_id'][910] = tracking
        env['combo_order_tracking_by_perm_id'][911] = tracking

        trade = SimpleNamespace(
            order=SimpleNamespace(orderId=910),
            orderStatus=SimpleNamespace(permId=911),
            contract=SimpleNamespace(secType='OPT', conId=111),
        )
        fill = SimpleNamespace(
            execution=SimpleNamespace(orderId=910, permId=911, execId='orphan-fill-1', shares=1, price=2.5, side='BOT'),
            contract=SimpleNamespace(secType='OPT', conId=111),
        )

        handler = build_combo_order_exec_details_handler(env)
        handler(trade, fill)
        await asyncio.sleep(0)

        self.assertEqual(sent_messages, [])
        self.assertEqual(tracking['fillTotals']['leg_call']['filledQuantity'], 1.0)
        self.assertEqual(tracking['fillTotals']['leg_call']['filledNotional'], 2.5)

        new_websocket = object()
        snapshot = build_active_combo_orders_snapshot(env, new_websocket, None)
        await asyncio.sleep(0)

        self.assertEqual(snapshot['action'], 'active_combo_orders_snapshot')
        self.assertEqual(len(snapshot['orders']), 1)
        self.assertEqual(snapshot['orders'][0]['groupId'], 'group_orphan')
        self.assertIs(tracking['websocket'], new_websocket)

        # The fills accumulated while orphaned must be replayed to the
        # re-attached session so leg costs are written back.
        fill_messages = [
            payload for ws, payload in sent_messages
            if ws is new_websocket and payload.get('action') == 'combo_order_fill_cost_update'
        ]
        self.assertEqual(len(fill_messages), 1)
        replayed_legs = fill_messages[0]['orderFill']['legs']
        self.assertEqual(len(replayed_legs), 1)
        self.assertEqual(replayed_legs[0]['id'], 'leg_call')
        self.assertEqual(replayed_legs[0]['avgFillPrice'], 2.5)
        self.assertEqual(replayed_legs[0]['filledQuantity'], 1.0)

    def test_upsert_combo_order_tracking_preserves_fills_across_passes(self):
        env, _sent_messages, _execution_engine = self._build_env()
        websocket = object()
        legs = [{'id': 'leg_call', 'conId': 121, 'expectedExecutionSide': 'BOT'}]

        pre_registered = upsert_combo_order_tracking(
            env,
            websocket=websocket,
            group_id='group_upsert',
            group_name='Upsert Combo',
            account='ACC-1',
            execution_mode='submit',
            execution_intent='open',
            request_source='trial_trigger',
            order_id=920,
            perm_id=None,
            status='PendingSubmit',
            legs=legs,
        )

        pre_registered['fillTotals']['leg_call'] = {
            'filledQuantity': 1.0,
            'filledNotional': 2.5,
        }
        pre_registered['seenExecIds'].add('early-fill-1')

        merged = upsert_combo_order_tracking(
            env,
            websocket=websocket,
            group_id='group_upsert',
            group_name='Upsert Combo',
            account='ACC-1',
            execution_mode='submit',
            execution_intent='open',
            request_source='trial_trigger',
            order_id=920,
            perm_id=921,
            status='Submitted',
            status_message='Order accepted.',
            legs=legs,
        )

        self.assertIs(merged, pre_registered)
        self.assertEqual(merged['fillTotals']['leg_call']['filledQuantity'], 1.0)
        self.assertIn('early-fill-1', merged['seenExecIds'])
        self.assertEqual(merged['status'], 'Submitted')
        self.assertEqual(merged['statusMessage'], 'Order accepted.')
        self.assertIs(env['combo_order_tracking_by_order_id'][920], merged)
        self.assertIs(env['combo_order_tracking_by_perm_id'][921], merged)

    async def test_active_combo_snapshot_pushes_terminal_state_and_drops_tracking(self):
        env, sent_messages, _execution_engine = self._build_env()
        new_websocket = object()
        live_tracking = {
            'websocket': None,
            'groupId': 'group_live',
            'groupName': 'Live Combo',
            'executionMode': 'submit',
            'executionIntent': 'open',
            'requestSource': 'trial_trigger',
            'orderId': 930,
            'permId': 931,
            'status': 'Submitted',
        }
        terminal_tracking = {
            'websocket': None,
            'groupId': 'group_done',
            'groupName': 'Done Combo',
            'executionMode': 'submit',
            'executionIntent': 'open',
            'requestSource': 'trial_trigger',
            'orderId': 932,
            'permId': 933,
            'status': 'Filled',
            'legs': [
                {
                    'id': 'leg_done',
                    'conId': 201,
                    'localSymbol': 'SPY  240621C00510000',
                    'symbol': 'SPY',
                    'secType': 'OPT',
                    'right': 'C',
                    'strike': 510,
                    'expDate': '20240621',
                    'targetPosition': 1,
                    'expectedExecutionSide': 'BOT',
                },
            ],
            'fillTotals': {
                'leg_done': {'filledQuantity': 1.0, 'filledNotional': 3.4},
            },
            'seenExecIds': {'done-fill-1'},
        }
        env['combo_order_tracking_by_order_id'][930] = live_tracking
        env['combo_order_tracking_by_perm_id'][931] = live_tracking
        env['combo_order_tracking_by_order_id'][932] = terminal_tracking
        env['combo_order_tracking_by_perm_id'][933] = terminal_tracking

        self.assertFalse(is_terminal_combo_tracking(env, live_tracking))
        self.assertTrue(is_terminal_combo_tracking(env, terminal_tracking))

        snapshot = build_active_combo_orders_snapshot(env, new_websocket, None)
        await asyncio.sleep(0)

        self.assertEqual(snapshot['action'], 'active_combo_orders_snapshot')
        self.assertEqual(len(snapshot['orders']), 1)
        self.assertEqual(snapshot['orders'][0]['groupId'], 'group_live')
        self.assertIs(live_tracking['websocket'], new_websocket)

        # The order that filled while disconnected delivers its final status
        # and attributed fill costs to the reconnected session, then the
        # tracking is dropped.
        terminal_status_messages = [
            payload for ws, payload in sent_messages
            if ws is new_websocket
            and payload.get('action') == 'combo_order_status_update'
            and payload.get('groupId') == 'group_done'
        ]
        self.assertEqual(len(terminal_status_messages), 1)
        self.assertEqual(terminal_status_messages[0]['orderStatus']['status'], 'Filled')

        terminal_fill_messages = [
            payload for ws, payload in sent_messages
            if ws is new_websocket
            and payload.get('action') == 'combo_order_fill_cost_update'
            and payload.get('groupId') == 'group_done'
        ]
        self.assertEqual(len(terminal_fill_messages), 1)
        self.assertEqual(terminal_fill_messages[0]['orderFill']['legs'][0]['avgFillPrice'], 3.4)

        self.assertNotIn(932, env['combo_order_tracking_by_order_id'])
        self.assertNotIn(933, env['combo_order_tracking_by_perm_id'])
        self.assertIn(930, env['combo_order_tracking_by_order_id'])

    async def test_active_combo_snapshot_does_not_steal_live_session_trackings(self):
        env, sent_messages, _execution_engine = self._build_env()
        owner_websocket = object()
        other_websocket = object()
        owned_tracking = {
            'websocket': owner_websocket,
            'groupId': 'group_owned',
            'groupName': 'Owned Combo',
            'executionMode': 'submit',
            'executionIntent': 'open',
            'requestSource': 'trial_trigger',
            'orderId': 940,
            'permId': 941,
            'status': 'Submitted',
            'legs': [
                {
                    'id': 'leg_owned',
                    'conId': 401,
                    'expectedExecutionSide': 'BOT',
                },
            ],
            'fillTotals': {
                'leg_owned': {'filledQuantity': 1.0, 'filledNotional': 2.0},
            },
            'seenExecIds': set(),
        }
        env['combo_order_tracking_by_order_id'][940] = owned_tracking
        env['combo_order_tracking_by_perm_id'][941] = owned_tracking

        snapshot = build_active_combo_orders_snapshot(env, other_websocket, None)
        await asyncio.sleep(0)

        # A tracking owned by another live session must stay fully with that
        # session: no re-bind, no snapshot entry, no replayed pushes.
        self.assertEqual(snapshot['orders'], [])
        self.assertIs(owned_tracking['websocket'], owner_websocket)
        self.assertEqual(sent_messages, [])
        self.assertIn(940, env['combo_order_tracking_by_order_id'])

        # The owning session itself may re-request and keeps everything.
        snapshot = build_active_combo_orders_snapshot(env, owner_websocket, None)
        await asyncio.sleep(0)
        self.assertEqual(len(snapshot['orders']), 1)
        self.assertIs(owned_tracking['websocket'], owner_websocket)


if __name__ == '__main__':
    unittest.main()
