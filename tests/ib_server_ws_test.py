import asyncio
import json
import pathlib
import sys
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


from ib_server_ws import (
    build_ws_client_handler,
    purge_combo_order_tracking_for_websocket,
    purge_hedge_order_tracking_for_websocket,
)


class _FakeWebSocket:
    def __init__(self, messages=None, remote_address=('127.0.0.1', 8765)):
        self._messages = list(messages or [])
        self.remote_address = remote_address
        self.sent = []

    def __aiter__(self):
        self._iter = iter(self._messages)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration

    async def send(self, message):
        self.sent.append(message)


class _ExecutionEngineStub:
    def __init__(self):
        self.calls = []
        self.cancel_calls = []

    async def handle_hedge_action(self, websocket, data, client_ip='Unknown'):
        self.calls.append(('hedge', websocket, data, client_ip))
        return None

    async def handle_combo_action(self, websocket, data, client_ip='Unknown'):
        self.calls.append(('combo', websocket, data, client_ip))
        return {'action': 'combo_order_preview_result', 'groupId': 'group_1'}

    def cancel_managed_for_websocket(self, websocket):
        self.cancel_calls.append(websocket)


class _FakeEventHook:
    def __init__(self):
        self.handlers = []

    def __iadd__(self, handler):
        self.handlers.append(handler)
        return self


class _FakeTicker:
    def __init__(self, contract):
        self.contract = contract
        self.updateEvent = _FakeEventHook()


class _FakeHistoricalReplayService:
    def __init__(self):
        self.snapshot_calls = []
        self.daily_bar_calls = []
        self.snapshot_payload = {'action': 'historical_replay_snapshot', 'underlyingPrice': 501.25}
        self.daily_bar_payload = {'action': 'historical_bars_response', 'dataSource': 'sqlite', 'bars': []}

    def build_snapshot_payload(self, requested_date, underlying_request, options_data):
        self.snapshot_calls.append((requested_date, underlying_request, options_data))
        return self.snapshot_payload

    def build_underlying_daily_bars_payload(self, symbol, limit=260):
        self.daily_bar_calls.append((symbol, limit))
        return dict(self.daily_bar_payload)


class _FakeIB:
    def __init__(self):
        self.req_mkt_data_calls = []

    def reqMktData(self, contract, generic_ticks, snapshot, regulatory_snapshot):
        self.req_mkt_data_calls.append((contract, generic_ticks, snapshot, regulatory_snapshot))
        return _FakeTicker(contract)


class IbServerWsHandlerTests(unittest.TestCase):
    def _build_env(self):
        sent_messages = []
        snapshot_calls = []
        managed_snapshot_calls = []
        cancel_iv_calls = []
        unsubscribe_calls = []
        ensure_connect_calls = []
        active_hedge_snapshot_calls = []
        iv_subscription_calls = []
        historical_bar_calls = []
        historical_replay_service = _FakeHistoricalReplayService()
        fake_ib = _FakeIB()

        async def send_message_safe(websocket, message):
            sent_messages.append((websocket, json.loads(message)))

        async def cancel_iv_term_structure_sync_task(websocket):
            cancel_iv_calls.append(websocket)

        async def ensure_ib_connect_task():
            ensure_connect_calls.append(True)
            return 'Connecting to IB.'

        def unsubscribe_client_safely(websocket):
            unsubscribe_calls.append(websocket)

        def build_active_hedge_orders_snapshot(websocket, data):
            active_hedge_snapshot_calls.append((websocket, data))
            return {
                'action': 'active_hedge_orders_snapshot',
                'items': [{'hedgeId': 'delta_spy'}],
                'requestId': data.get('requestId'),
            }

        async def qualify_one(contract, request=None):
            request_data = request if isinstance(request, dict) else {}
            sec_type = str(request_data.get('secType') or getattr(contract, 'secType', '') or 'STK').upper()
            symbol = str(request_data.get('symbol') or getattr(contract, 'symbol', '') or 'UNKNOWN').upper()
            if sec_type == 'OPT':
                con_id = 2000 + len(symbol)
            elif sec_type == 'FUT':
                con_id = 3000 + len(symbol)
            else:
                con_id = 1000 + len(symbol)
            return type('QualifiedContract', (), {
                'conId': con_id,
                'secType': sec_type,
                'symbol': symbol,
            })()

        async def handle_iv_term_structure_subscription(websocket, client_ip, data):
            iv_subscription_calls.append((websocket, client_ip, data))

        async def request_ib_historical_bars(
            underlying_request,
            *,
            bar_size='1 day',
            duration_str='2 Y',
            use_rth=True,
            limit=260,
        ):
            historical_bar_calls.append({
                'underlying_request': underlying_request,
                'bar_size': bar_size,
                'duration_str': duration_str,
                'use_rth': use_rth,
                'limit': limit,
            })
            return {
                'action': 'historical_bars_response',
                'symbol': str((underlying_request or {}).get('symbol') or '').upper(),
                'barSize': bar_size,
                'durationStr': duration_str,
                'dataSource': 'ibkr',
                'useRTH': use_rth,
                'bars': [{'time': '2026-05-01', 'open': 1.0, 'high': 2.0, 'low': 0.5, 'close': 1.5, 'volume': 100}],
            }

        env = {
            'connected_clients': set(),
            'client_subscriptions': {},
            'client_subscription_settings': {},
            'historical_replay_service': historical_replay_service,
            'execution_engine': _ExecutionEngineStub(),
            'send_portfolio_avg_cost_snapshot': lambda websocket: snapshot_calls.append(websocket),
            'send_managed_accounts_snapshot': lambda websocket: managed_snapshot_calls.append(websocket),
            'cancel_iv_term_structure_sync_task': cancel_iv_term_structure_sync_task,
            'unsubscribe_client_safely': unsubscribe_client_safely,
            'send_message_safe': send_message_safe,
            'build_underlying_request': lambda raw_underlying, _options: (
                raw_underlying if isinstance(raw_underlying, dict)
                else {'secType': 'STK', 'symbol': str(raw_underlying or '').upper(), 'exchange': 'SMART', 'currency': 'USD'}
            ),
            'normalize_replay_date': lambda value: value,
            'describe_contract_request': lambda request: (
                f"{str(request.get('secType') or '').upper()} {str(request.get('symbol') or '').upper()}".strip()
                if isinstance(request, dict)
                else str(request)
            ),
            'build_ib_connection_status_payload': lambda message=None: {
                'action': 'ib_connection_status',
                'connected': False,
                'message': message,
            },
            'ensure_ib_connect_task': ensure_ib_connect_task,
            'build_active_hedge_orders_snapshot': build_active_hedge_orders_snapshot,
            'normalize_bool': lambda value, default=False: default if value is None else str(value).strip().lower() in ('1', 'true', 'yes', 'on'),
            'build_contract_from_request': lambda request: type('ContractRequest', (), {
                'secType': str((request or {}).get('secType') or 'STK').upper(),
                'symbol': str((request or {}).get('symbol') or 'UNKNOWN').upper(),
            })(),
            'get_client_subscription_settings': lambda websocket: env['client_subscription_settings'].setdefault(
                websocket,
                {'greeks_enabled': False},
            ),
            'qualify_one': qualify_one,
            'handle_iv_term_structure_subscription': handle_iv_term_structure_subscription,
            'extract_quote_snapshot': lambda ticker, _sec_type='': {
                'bid': 500.0,
                'ask': 501.0,
                'mark': 500.5,
            },
            'request_ib_historical_bars': request_ib_historical_bars,
            'coerce_positive_int': lambda value, default: int(value) if str(value).strip().isdigit() and int(value) > 0 else default,
            'normalize_symbol': lambda value: str(value or '').strip().upper(),
            'combo_order_tracking_by_order_id': {},
            'combo_order_tracking_by_perm_id': {},
            'hedge_order_tracking_by_order_id': {},
            'hedge_order_tracking_by_perm_id': {},
            'iter_unique_hedge_order_trackings': lambda: [],
            'is_terminal_hedge_tracking': lambda tracking: False,
            'extract_market_price': lambda ticker: getattr(ticker, 'mark', None),
            'ib': fake_ib,
            '_captures': {
                'sent_messages': sent_messages,
                'snapshot_calls': snapshot_calls,
                'managed_snapshot_calls': managed_snapshot_calls,
                'cancel_iv_calls': cancel_iv_calls,
                'unsubscribe_calls': unsubscribe_calls,
                'ensure_connect_calls': ensure_connect_calls,
                'active_hedge_snapshot_calls': active_hedge_snapshot_calls,
                'iv_subscription_calls': iv_subscription_calls,
                'historical_bar_calls': historical_bar_calls,
            },
        }
        return (
            env,
            sent_messages,
            snapshot_calls,
            managed_snapshot_calls,
            cancel_iv_calls,
            unsubscribe_calls,
            ensure_connect_calls,
            active_hedge_snapshot_calls,
        )

    def test_handle_ws_client_bootstraps_and_cleans_up_session(self):
        (
            env,
            sent_messages,
            snapshot_calls,
            managed_snapshot_calls,
            cancel_iv_calls,
            unsubscribe_calls,
            _ensure_connect_calls,
            _active_hedge_snapshot_calls,
        ) = self._build_env()
        websocket = _FakeWebSocket()
        handler = build_ws_client_handler(env)

        asyncio.run(handler(websocket))

        self.assertEqual(sent_messages, [])
        self.assertEqual(snapshot_calls, [websocket])
        self.assertEqual(managed_snapshot_calls, [websocket])
        self.assertEqual(cancel_iv_calls, [websocket])
        self.assertEqual(unsubscribe_calls, [websocket])
        self.assertEqual(env['connected_clients'], set())
        self.assertNotIn(websocket, env['client_subscriptions'])
        self.assertNotIn(websocket, env['client_subscription_settings'])
        self.assertEqual(env['execution_engine'].cancel_calls, [websocket])

    def test_handle_ws_client_routes_unknown_actions_to_execution_engine(self):
        (
            env,
            sent_messages,
            _snapshot_calls,
            _managed_snapshot_calls,
            _cancel_iv_calls,
            _unsubscribe_calls,
            _ensure_connect_calls,
            _active_hedge_snapshot_calls,
        ) = self._build_env()
        websocket = _FakeWebSocket(messages=[json.dumps({'action': 'preview_combo_order', 'groupId': 'group_1'})])
        handler = build_ws_client_handler(env)

        asyncio.run(handler(websocket))

        self.assertEqual(len(env['execution_engine'].calls), 2)
        self.assertEqual(env['execution_engine'].calls[0][0], 'hedge')
        self.assertEqual(env['execution_engine'].calls[1][0], 'combo')
        self.assertEqual(sent_messages[0][1]['action'], 'combo_order_preview_result')
        self.assertEqual(sent_messages[0][1]['groupId'], 'group_1')

    def test_handle_ws_client_routes_managed_account_snapshot_action(self):
        (
            env,
            _sent_messages,
            _snapshot_calls,
            managed_snapshot_calls,
            _cancel_iv_calls,
            _unsubscribe_calls,
            _ensure_connect_calls,
            _active_hedge_snapshot_calls,
        ) = self._build_env()
        websocket = _FakeWebSocket(messages=[json.dumps({'action': 'request_managed_accounts_snapshot'})])
        handler = build_ws_client_handler(env)

        asyncio.run(handler(websocket))

        self.assertEqual(managed_snapshot_calls, [websocket, websocket])

    def test_handle_ws_client_routes_ib_connection_status_action(self):
        (
            env,
            sent_messages,
            _snapshot_calls,
            _managed_snapshot_calls,
            _cancel_iv_calls,
            _unsubscribe_calls,
            _ensure_connect_calls,
            _active_hedge_snapshot_calls,
        ) = self._build_env()
        websocket = _FakeWebSocket(messages=[json.dumps({'action': 'request_ib_connection_status'})])
        handler = build_ws_client_handler(env)

        asyncio.run(handler(websocket))

        self.assertEqual(sent_messages[0][1], {
            'action': 'ib_connection_status',
            'connected': False,
            'message': None,
        })

    def test_handle_ws_client_routes_connect_ib_action(self):
        (
            env,
            sent_messages,
            _snapshot_calls,
            _managed_snapshot_calls,
            _cancel_iv_calls,
            _unsubscribe_calls,
            ensure_connect_calls,
            _active_hedge_snapshot_calls,
        ) = self._build_env()
        websocket = _FakeWebSocket(messages=[json.dumps({'action': 'connect_ib'})])
        handler = build_ws_client_handler(env)

        asyncio.run(handler(websocket))

        self.assertEqual(ensure_connect_calls, [True])
        self.assertEqual(sent_messages[0][1], {
            'action': 'ib_connection_status',
            'connected': False,
            'message': 'Connecting to IB.',
        })

    def test_handle_ws_client_routes_active_hedge_snapshot_action(self):
        (
            env,
            sent_messages,
            _snapshot_calls,
            _managed_snapshot_calls,
            _cancel_iv_calls,
            _unsubscribe_calls,
            _ensure_connect_calls,
            active_hedge_snapshot_calls,
        ) = self._build_env()
        websocket = _FakeWebSocket(messages=[json.dumps({
            'action': 'request_active_hedge_orders_snapshot',
            'requestId': 'req_hedge_1',
        })])
        handler = build_ws_client_handler(env)

        asyncio.run(handler(websocket))

        self.assertEqual(active_hedge_snapshot_calls, [(
            websocket,
            {'action': 'request_active_hedge_orders_snapshot', 'requestId': 'req_hedge_1'},
        )])
        self.assertEqual(sent_messages[0][1], {
            'action': 'active_hedge_orders_snapshot',
            'items': [{'hedgeId': 'delta_spy'}],
            'requestId': 'req_hedge_1',
        })

    def test_handle_ws_client_routes_historical_snapshot_action(self):
        (
            env,
            sent_messages,
            _snapshot_calls,
            _managed_snapshot_calls,
            cancel_iv_calls,
            unsubscribe_calls,
            _ensure_connect_calls,
            _active_hedge_snapshot_calls,
        ) = self._build_env()
        websocket = _FakeWebSocket(messages=[json.dumps({
            'action': 'request_historical_snapshot',
            'replayDate': '2026-05-01',
            'underlying': {'secType': 'STK', 'symbol': 'SPY'},
            'options': [{'id': 'leg_1', 'secType': 'OPT', 'symbol': 'SPY'}],
        })])
        handler = build_ws_client_handler(env)

        asyncio.run(handler(websocket))

        self.assertEqual(
            env['historical_replay_service'].snapshot_calls,
            [('2026-05-01', {'secType': 'STK', 'symbol': 'SPY'}, [{'id': 'leg_1', 'secType': 'OPT', 'symbol': 'SPY'}])],
        )
        self.assertEqual(sent_messages[0][1], {'action': 'historical_replay_snapshot', 'underlyingPrice': 501.25})
        self.assertGreaterEqual(cancel_iv_calls.count(websocket), 2)
        self.assertGreaterEqual(unsubscribe_calls.count(websocket), 2)

    def test_handle_ws_client_routes_historical_bars_action(self):
        (
            env,
            sent_messages,
            _snapshot_calls,
            _managed_snapshot_calls,
            _cancel_iv_calls,
            _unsubscribe_calls,
            _ensure_connect_calls,
            _active_hedge_snapshot_calls,
        ) = self._build_env()
        websocket = _FakeWebSocket(messages=[json.dumps({
            'action': 'request_historical_bars',
            'underlying': {'secType': 'FUT', 'symbol': 'ES'},
            'barSize': '1 day',
            'durationStr': '6 M',
            'useRTH': False,
            'limit': 42,
            'requestId': 'bars_1',
        })])
        handler = build_ws_client_handler(env)

        asyncio.run(handler(websocket))

        self.assertEqual(env['_captures']['historical_bar_calls'], [{
            'underlying_request': {'secType': 'FUT', 'symbol': 'ES'},
            'bar_size': '1 day',
            'duration_str': '6 M',
            'use_rth': False,
            'limit': 42,
        }])
        self.assertEqual(sent_messages[0][1], {
            'action': 'historical_bars_response',
            'symbol': 'ES',
            'barSize': '1 day',
            'durationStr': '6 M',
            'dataSource': 'ibkr',
            'useRTH': False,
            'bars': [{'time': '2026-05-01', 'open': 1.0, 'high': 2.0, 'low': 0.5, 'close': 1.5, 'volume': 100}],
            'requestId': 'bars_1',
        })

    def test_handle_ws_client_routes_subscribe_action(self):
        (
            env,
            _sent_messages,
            _snapshot_calls,
            _managed_snapshot_calls,
            cancel_iv_calls,
            unsubscribe_calls,
            _ensure_connect_calls,
            _active_hedge_snapshot_calls,
        ) = self._build_env()
        websocket = _FakeWebSocket(messages=[json.dumps({
            'action': 'subscribe',
            'greeksEnabled': True,
            'underlying': {'secType': 'FUT', 'symbol': 'ES'},
            'options': [{'id': 'leg_es_call', 'secType': 'OPT', 'symbol': 'ES'}],
            'futures': [{'id': 'hedge_future', 'secType': 'FUT', 'symbol': 'MES'}],
            'stocks': ['SPY'],
        })])
        handler = build_ws_client_handler(env)

        asyncio.run(handler(websocket))

        req_mkt_data_calls = env['ib'].req_mkt_data_calls
        self.assertEqual(len(req_mkt_data_calls), 4)
        self.assertEqual(req_mkt_data_calls[0][1], '')
        self.assertEqual(req_mkt_data_calls[1][1], '106')
        self.assertEqual(req_mkt_data_calls[2][1], '')
        self.assertEqual(req_mkt_data_calls[3][1], '')
        self.assertTrue(any(call[0].symbol == 'SPY' for call in req_mkt_data_calls))
        self.assertGreaterEqual(cancel_iv_calls.count(websocket), 2)
        self.assertGreaterEqual(unsubscribe_calls.count(websocket), 2)

    def test_handle_ws_client_routes_iv_term_structure_action(self):
        (
            env,
            _sent_messages,
            _snapshot_calls,
            _managed_snapshot_calls,
            _cancel_iv_calls,
            _unsubscribe_calls,
            _ensure_connect_calls,
            _active_hedge_snapshot_calls,
        ) = self._build_env()
        websocket = _FakeWebSocket(messages=[json.dumps({
            'action': 'subscribe_iv_term_structure',
            'underlying': {'secType': 'IND', 'symbol': 'SPX'},
        })])
        handler = build_ws_client_handler(env)

        asyncio.run(handler(websocket))

        self.assertEqual(env['_captures']['iv_subscription_calls'], [(
            websocket,
            '127.0.0.1',
            {'action': 'subscribe_iv_term_structure', 'underlying': {'secType': 'IND', 'symbol': 'SPX'}},
        )])

    def test_purge_combo_order_tracking_removes_only_matching_websocket(self):
        ws_target = object()
        ws_other = object()
        tracking_target = {'websocket': ws_target}
        tracking_other = {'websocket': ws_other}
        by_order_id = {1: tracking_target, 2: tracking_other}
        by_perm_id = {11: tracking_target, 22: tracking_other}

        purge_combo_order_tracking_for_websocket(ws_target, by_order_id, by_perm_id)

        self.assertEqual(by_order_id, {2: tracking_other})
        self.assertEqual(by_perm_id, {22: tracking_other})

    def test_purge_hedge_order_tracking_clears_terminal_and_detaches_live_entries(self):
        ws_target = object()
        terminal_tracking = {'websocket': ws_target, 'orderId': 1, 'permId': 11, 'terminal': True}
        live_tracking = {'websocket': ws_target, 'orderId': 2, 'permId': 22, 'terminal': False}
        by_order_id = {1: terminal_tracking, 2: live_tracking}
        by_perm_id = {11: terminal_tracking, 22: live_tracking}

        purge_hedge_order_tracking_for_websocket(
            ws_target,
            iter_unique_hedge_order_trackings=lambda: [terminal_tracking, live_tracking],
            is_terminal_hedge_tracking=lambda tracking: tracking.get('terminal') is True,
            hedge_order_tracking_by_order_id=by_order_id,
            hedge_order_tracking_by_perm_id=by_perm_id,
        )

        self.assertEqual(by_order_id, {2: live_tracking})
        self.assertEqual(by_perm_id, {22: live_tracking})
        self.assertIsNone(live_tracking['websocket'])


if __name__ == '__main__':
    unittest.main()
