import asyncio
import json
import pathlib
import sys
import unittest
from unittest.mock import AsyncMock, patch


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


from ib_server_ws import (
    build_ws_client_handler,
    dispatch_client_message,
    purge_combo_order_tracking_for_websocket,
    purge_hedge_order_tracking_for_websocket,
)
from ib_server_market_data import (
    cancel_all_api_market_data_subscriptions,
    extract_market_reference_contract_metadata,
    extract_option_mark_with_source,
    extract_quote_snapshot,
    ticker_quote_fingerprint,
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

    def release_managed_for_websocket(self, websocket):
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
        self.cancel_mkt_data_calls = []

    def reqMktData(self, contract, generic_ticks, snapshot, regulatory_snapshot):
        self.req_mkt_data_calls.append((contract, generic_ticks, snapshot, regulatory_snapshot))
        return _FakeTicker(contract)

    def cancelMktData(self, contract):
        self.cancel_mkt_data_calls.append(contract)


class IbServerWsHandlerTests(unittest.TestCase):
    def _build_env(self):
        sent_messages = []
        snapshot_calls = []
        position_snapshot_calls = []
        managed_snapshot_calls = []
        cancel_iv_calls = []
        unsubscribe_calls = []
        ensure_connect_calls = []
        reset_api_subscription_calls = []
        active_hedge_snapshot_calls = []
        iv_subscription_calls = []
        historical_bar_calls = []
        discount_curve_calls = []
        historical_replay_service = _FakeHistoricalReplayService()
        fake_ib = _FakeIB()

        async def send_message_safe(websocket, message):
            sent_messages.append((websocket, json.loads(message)))

        async def cancel_iv_term_structure_sync_task(websocket):
            cancel_iv_calls.append(websocket)

        async def ensure_ib_connect_task():
            ensure_connect_calls.append(True)
            return 'Connecting to IB.'

        async def reset_all_api_market_data_subscriptions(client_ip):
            reset_api_subscription_calls.append(client_ip)
            return {
                'action': 'api_market_data_subscriptions_reset',
                'success': True,
                'knownTickerCount': 4,
                'trackedClientCount': 2,
                'reconnecting': True,
                'message': 'All API market-data subscriptions were cleared.',
            }

        def unsubscribe_client_safely(websocket):
            unsubscribe_calls.append(websocket)

        def build_active_hedge_orders_snapshot(websocket, data):
            active_hedge_snapshot_calls.append((websocket, data))
            return {
                'action': 'active_hedge_orders_snapshot',
                'items': [{'hedgeId': 'delta_spy'}],
                'requestId': data.get('requestId'),
            }

        active_combo_snapshot_calls = []

        def build_active_combo_orders_snapshot(websocket, data):
            active_combo_snapshot_calls.append((websocket, data))
            return {
                'action': 'active_combo_orders_snapshot',
                'orders': [],
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

        async def get_discount_curve_snapshot(data):
            discount_curve_calls.append(dict(data))
            return {
                'action': 'discount_curve_snapshot',
                'status': 'cached',
                'fallbackUsed': False,
                'refreshAttempted': False,
                'error': '',
                'curve': {
                    'kind': 'treasury_discount_curve',
                    'effectiveDate': '2026-05-01',
                    'points': [{'tenorCode': '1m', 'tenorDays': 30, 'parYield': 0.04}],
                },
            }

        env = {
            'connected_clients': set(),
            'client_subscriptions': {},
            'client_subscription_settings': {},
            'historical_replay_service': historical_replay_service,
            'get_discount_curve_snapshot': get_discount_curve_snapshot,
            'execution_engine': _ExecutionEngineStub(),
            'send_portfolio_avg_cost_snapshot': lambda websocket: snapshot_calls.append(websocket),
            'send_portfolio_positions_snapshot': lambda websocket: position_snapshot_calls.append(websocket),
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
            'reset_all_api_market_data_subscriptions': reset_all_api_market_data_subscriptions,
            'build_active_hedge_orders_snapshot': build_active_hedge_orders_snapshot,
            'build_active_combo_orders_snapshot': build_active_combo_orders_snapshot,
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
                'position_snapshot_calls': position_snapshot_calls,
                'managed_snapshot_calls': managed_snapshot_calls,
                'cancel_iv_calls': cancel_iv_calls,
                'unsubscribe_calls': unsubscribe_calls,
                'ensure_connect_calls': ensure_connect_calls,
                'reset_api_subscription_calls': reset_api_subscription_calls,
                'active_hedge_snapshot_calls': active_hedge_snapshot_calls,
                'active_combo_snapshot_calls': active_combo_snapshot_calls,
                'iv_subscription_calls': iv_subscription_calls,
                'historical_bar_calls': historical_bar_calls,
                'discount_curve_calls': discount_curve_calls,
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
        self.assertEqual(env['_captures']['position_snapshot_calls'], [websocket])
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

    def test_handle_ws_client_routes_portfolio_positions_snapshot_action(self):
        env, *_rest = self._build_env()
        websocket = _FakeWebSocket(messages=[json.dumps({'action': 'request_portfolio_positions_snapshot'})])
        handler = build_ws_client_handler(env)

        asyncio.run(handler(websocket))

        self.assertEqual(env['_captures']['position_snapshot_calls'], [websocket, websocket])

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

    def test_handle_ws_client_routes_discount_curve_snapshot_action(self):
        env, sent_messages, *_ = self._build_env()
        websocket = _FakeWebSocket(messages=[json.dumps({
            'action': 'request_discount_curve',
            'requestedDate': '2026-05-02',
            'refresh': False,
        })])
        handler = build_ws_client_handler(env)

        asyncio.run(handler(websocket))

        self.assertEqual(env['_captures']['discount_curve_calls'], [{
            'action': 'request_discount_curve',
            'requestedDate': '2026-05-02',
            'refresh': False,
        }])
        self.assertEqual(sent_messages[0][1]['action'], 'discount_curve_snapshot')
        self.assertEqual(sent_messages[0][1]['status'], 'cached')
        self.assertEqual(sent_messages[0][1]['curve']['effectiveDate'], '2026-05-01')

    def test_discount_curve_action_fails_closed_when_backend_has_no_provider(self):
        env, sent_messages, *_ = self._build_env()
        env.pop('get_discount_curve_snapshot')
        websocket = _FakeWebSocket()

        asyncio.run(dispatch_client_message(
            env,
            websocket,
            {'action': 'request_discount_curve'},
        ))

        self.assertEqual(sent_messages[0][1]['action'], 'discount_curve_snapshot')
        self.assertEqual(sent_messages[0][1]['status'], 'unavailable')
        self.assertIsNone(sent_messages[0][1]['curve'])

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

    def test_global_api_subscription_reset_requires_explicit_confirmation(self):
        env, sent_messages, *_ = self._build_env()
        websocket = _FakeWebSocket()

        asyncio.run(dispatch_client_message(
            env,
            websocket,
            {'action': 'reset_api_market_data_subscriptions'},
            client_ip='10.0.0.8',
        ))

        self.assertEqual(env['_captures']['reset_api_subscription_calls'], [])
        self.assertEqual(len(sent_messages), 1)
        self.assertFalse(sent_messages[0][1]['success'])
        self.assertIn('confirmation', sent_messages[0][1]['message'].lower())

    def test_global_api_subscription_reset_broadcasts_to_every_connected_session(self):
        env, sent_messages, *_ = self._build_env()
        requester = _FakeWebSocket()
        other_session = _FakeWebSocket()
        env['connected_clients'].update((requester, other_session))

        asyncio.run(dispatch_client_message(
            env,
            requester,
            {'action': 'reset_api_market_data_subscriptions', 'confirmed': True},
            client_ip='10.0.0.9',
        ))

        self.assertEqual(env['_captures']['reset_api_subscription_calls'], ['10.0.0.9'])
        recipients = {sent_websocket for sent_websocket, _payload in sent_messages}
        self.assertEqual(recipients, {requester, other_session})
        self.assertTrue(all(payload['success'] for _websocket, payload in sent_messages))

    def test_subscription_started_before_global_reset_cannot_open_a_late_stream(self):
        env, *_ = self._build_env()
        websocket = _FakeWebSocket()
        env['client_subscriptions'][websocket] = {}
        generation = [3]
        env['get_api_market_data_generation'] = lambda: generation[0]

        async def qualify_after_reset(contract, request=None):
            generation[0] += 1
            return type('QualifiedContract', (), {
                'conId': 404,
                'secType': 'STK',
                'symbol': 'SPY',
            })()

        env['qualify_one'] = qualify_after_reset
        asyncio.run(dispatch_client_message(
            env,
            websocket,
            {
                'action': 'subscribe',
                'underlying': {'secType': 'STK', 'symbol': 'SPY'},
                'options': [],
                'futures': [],
                'stocks': [],
            },
        ))

        self.assertEqual(env['ib'].req_mkt_data_calls, [])
        self.assertEqual(env['client_subscriptions'][websocket], {})

    def test_reset_during_option_timing_lookup_cannot_attach_or_send_stale_metadata(self):
        env, sent_messages, *_ = self._build_env()
        websocket = _FakeWebSocket()
        env['client_subscriptions'][websocket] = {}
        env['client_subscription_settings'][websocket] = {'greeks_enabled': False}
        generation = [11]
        env['get_api_market_data_generation'] = lambda: generation[0]
        env['api_market_data_reset_in_progress'] = lambda: False
        env['option_contract_timing_by_con_id'] = {}

        async def qualify_contract(contract, request=None):
            request_data = request if isinstance(request, dict) else {}
            sec_type = str(
                request_data.get('secType')
                or getattr(contract, 'secType', '')
                or 'STK'
            ).upper()
            return type('QualifiedContract', (), {
                'conId': 901 if sec_type == 'OPT' else 900,
                'secType': sec_type,
                'symbol': 'SPY',
            })()

        async def resolve_timing_after_reset(_qualified_option):
            await asyncio.sleep(0)
            generation[0] += 1
            return {
                'conId': 901,
                'secType': 'OPT',
                'symbol': 'SPY',
                'localSymbol': 'SPY   260724P00750000',
                'right': 'P',
                'strike': 750.0,
                'optionExpiry': '20260724',
                'expiryAsOf': '2026-07-24T20:00:00.000Z',
                'expiryTimingSource': 'ib_contract_details',
                'lastTradeDate': '20260724',
            }

        env['qualify_one'] = qualify_contract
        env['resolve_option_contract_timing'] = resolve_timing_after_reset
        asyncio.run(dispatch_client_message(
            env,
            websocket,
            {
                'action': 'subscribe',
                'underlying': {'secType': 'STK', 'symbol': 'SPY'},
                'options': [{
                    'id': 'late_leg',
                    'secType': 'OPT',
                    'symbol': 'SPY',
                    'expDate': '20260724',
                    'strike': 750,
                    'right': 'P',
                }],
                'futures': [],
                'stocks': [],
            },
        ))

        self.assertNotIn('late_leg', env['client_subscriptions'][websocket])
        self.assertFalse(any(
            socket is websocket
            and payload.get('action') == 'option_contract_metadata'
            and 'late_leg' in (payload.get('options') or {})
            for socket, payload in sent_messages
        ))
        option_market_data_calls = [
            call for call in env['ib'].req_mkt_data_calls
            if getattr(call[0], 'secType', '') == 'OPT'
        ]
        self.assertEqual(option_market_data_calls, [])

    def test_unqualified_option_leg_is_reported_to_the_client(self):
        # A strike IBKR does not list for the chosen expiry used to vanish from
        # every payload with no client-visible trace, so the feed toggle looked
        # like it was still loading forever.
        env, sent_messages, *_ = self._build_env()
        websocket = _FakeWebSocket()
        env['client_subscriptions'][websocket] = {}
        env['client_subscription_settings'][websocket] = {'greeks_enabled': False}

        async def qualify_missing_strike(contract, request=None):
            request_data = request if isinstance(request, dict) else {}
            if float(request_data.get('strike') or 0) == 585.0:
                return None
            sec_type = str(request_data.get('secType') or getattr(contract, 'secType', '') or 'STK').upper()
            return type('QualifiedContract', (), {
                'conId': 2001 if sec_type == 'OPT' else 1001,
                'secType': sec_type,
                'symbol': 'QQQ',
            })()

        env['qualify_one'] = qualify_missing_strike
        asyncio.run(dispatch_client_message(
            env,
            websocket,
            {
                'action': 'subscribe',
                'underlying': {'secType': 'STK', 'symbol': 'QQQ'},
                'options': [
                    {
                        'id': 'leg_missing',
                        'secType': 'OPT',
                        'symbol': 'QQQ',
                        'expDate': '20260821',
                        'strike': 585,
                        'right': 'C',
                    },
                    {
                        'id': 'leg_ok',
                        'secType': 'OPT',
                        'symbol': 'QQQ',
                        'expDate': '20260821',
                        'strike': 570,
                        'right': 'P',
                    },
                ],
                'futures': [],
                'stocks': [],
            },
        ))

        status_payloads = [
            payload for socket, payload in sent_messages
            if socket is websocket and payload.get('action') == 'option_subscription_status'
        ]
        self.assertEqual(len(status_payloads), 1)
        unresolved = status_payloads[0]['unresolved']
        self.assertEqual(len(unresolved), 1)
        self.assertEqual(unresolved[0]['id'], 'leg_missing')
        self.assertEqual(unresolved[0]['reason'], 'contract_not_found')
        self.assertEqual(unresolved[0]['strike'], 585)
        self.assertEqual(unresolved[0]['right'], 'C')
        self.assertEqual(unresolved[0]['expDate'], '20260821')

        # The unresolved leg must not subscribe; its sibling still must.
        self.assertNotIn('leg_missing', env['client_subscriptions'][websocket])
        self.assertIn('leg_ok', env['client_subscriptions'][websocket])

    def test_fully_qualified_subscription_reports_an_empty_unresolved_list(self):
        # The all-clear lets the client retire a previous "not found" warning.
        env, sent_messages, *_ = self._build_env()
        websocket = _FakeWebSocket()
        env['client_subscriptions'][websocket] = {}
        env['client_subscription_settings'][websocket] = {'greeks_enabled': False}

        asyncio.run(dispatch_client_message(
            env,
            websocket,
            {
                'action': 'subscribe',
                'underlying': {'secType': 'STK', 'symbol': 'QQQ'},
                'options': [{
                    'id': 'leg_ok',
                    'secType': 'OPT',
                    'symbol': 'QQQ',
                    'expDate': '20260821',
                    'strike': 570,
                    'right': 'P',
                }],
                'futures': [],
                'stocks': [],
            },
        ))

        status_payloads = [
            payload for socket, payload in sent_messages
            if socket is websocket and payload.get('action') == 'option_subscription_status'
        ]
        self.assertEqual(len(status_payloads), 1)
        self.assertEqual(status_payloads[0]['unresolved'], [])

    def test_subscription_arriving_during_global_reset_is_rejected(self):
        env, *_ = self._build_env()
        websocket = _FakeWebSocket()
        env['client_subscriptions'][websocket] = {}
        env['get_api_market_data_generation'] = lambda: 7
        env['api_market_data_reset_in_progress'] = lambda: True

        asyncio.run(dispatch_client_message(
            env,
            websocket,
            {
                'action': 'subscribe',
                'underlying': {'secType': 'STK', 'symbol': 'SPY'},
                'options': [],
                'futures': [],
                'stocks': [],
            },
        ))

        self.assertEqual(env['ib'].req_mkt_data_calls, [])
        self.assertEqual(env['client_subscriptions'][websocket], {})

    def test_cancel_all_api_market_data_subscriptions_clears_every_session(self):
        first_contract = type('Contract', (), {'conId': 101})()
        duplicate_contract = type('Contract', (), {'conId': 101})()
        second_contract = type('Contract', (), {'conId': 202})()
        first_ticker = _FakeTicker(first_contract)
        duplicate_ticker = _FakeTicker(duplicate_contract)
        second_ticker = _FakeTicker(second_contract)

        class _ResettableIB:
            def __init__(self):
                self.cancelled = []

            def tickers(self):
                return [first_ticker, second_ticker]

            def cancelMktData(self, contract):
                self.cancelled.append(contract.conId)
                return True

        fake_ib = _ResettableIB()
        first_session = object()
        second_session = object()
        subscriptions = {
            first_session: {'first': first_ticker, 'duplicate': duplicate_ticker},
            second_session: {'second': second_ticker},
        }
        generic_ticks = {101: {'106'}, 202: set()}

        result = cancel_all_api_market_data_subscriptions(
            ib=fake_ib,
            client_subscriptions=subscriptions,
            generic_ticks_by_con_id=generic_ticks,
        )

        self.assertEqual(result, {
            'knownTickerCount': 2,
            'cancelledTickerCount': 2,
            'cancelErrorCount': 0,
        })
        self.assertEqual(fake_ib.cancelled, [101, 202])
        self.assertEqual(subscriptions, {first_session: {}, second_session: {}})
        self.assertEqual(generic_ticks, {})

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

    def test_optional_carry_reference_is_subscribed_separately(self):
        env, *_ = self._build_env()
        websocket = _FakeWebSocket()
        env['client_subscriptions'][websocket] = {}

        asyncio.run(dispatch_client_message(env, websocket, {
            'action': 'subscribe',
            'underlying': {'secType': 'FUT', 'symbol': 'ES'},
            'options': [{'id': 'leg', 'secType': 'FOP', 'symbol': 'ES'}],
            'futures': [{'id': 'esu6', 'secType': 'FUT', 'symbol': 'ES'}],
            'carryReferences': [
                {'id': 'spot', 'secType': 'IND', 'symbol': 'SPX', 'exchange': 'CBOE'},
            ],
            'stocks': [],
        }))

        subscriptions = env['client_subscriptions'][websocket]
        self.assertIn('leg', subscriptions)
        self.assertIn('future_esu6', subscriptions)
        self.assertIn('carry_reference_spot', subscriptions)
        self.assertEqual(subscriptions['carry_reference_spot'].contract.symbol, 'SPX')

    def test_optional_carry_reference_failure_does_not_block_fop_or_stock_subscriptions(self):
        env, *_ = self._build_env()
        websocket = _FakeWebSocket()
        env['client_subscriptions'][websocket] = {}
        original_qualify = env['qualify_one']

        async def qualify_except_reference(contract, request=None):
            if isinstance(request, dict) and request.get('purpose') == 'diagnostic_net_carry_reference':
                raise RuntimeError('reference permission unavailable')
            return await original_qualify(contract, request)

        env['qualify_one'] = qualify_except_reference
        asyncio.run(dispatch_client_message(env, websocket, {
            'action': 'subscribe',
            'underlying': {'secType': 'FUT', 'symbol': 'ES'},
            'options': [{'id': 'leg', 'secType': 'FOP', 'symbol': 'ES'}],
            'futures': [{'id': 'esu6', 'secType': 'FUT', 'symbol': 'ES'}],
            'carryReferences': [{
                'id': 'spot',
                'secType': 'IND',
                'symbol': 'SPX',
                'purpose': 'diagnostic_net_carry_reference',
            }],
            'stocks': ['SPY'],
        }))

        subscriptions = env['client_subscriptions'][websocket]
        self.assertIn('leg', subscriptions)
        self.assertIn('future_esu6', subscriptions)
        self.assertIn('stock_SPY', subscriptions)
        self.assertNotIn('carry_reference_spot', subscriptions)

    def test_handle_subscribe_pools_market_data_lines_per_contract(self):
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

        async def qualify_by_key(contract, request=None):
            request_data = request if isinstance(request, dict) else {}
            sec_type = str(request_data.get('secType') or getattr(contract, 'secType', '') or 'STK').upper()
            symbol = str(request_data.get('symbol') or getattr(contract, 'symbol', '') or 'UNKNOWN').upper()
            strike = str(request_data.get('strike') or '')
            right = str(request_data.get('right') or '')
            key = f'{sec_type}|{symbol}|{strike}|{right}'
            con_id = abs(hash(key)) % 100000 + 1
            return type('QualifiedContract', (), {
                'conId': con_id,
                'secType': sec_type,
                'symbol': symbol,
            })()

        env['qualify_one'] = qualify_by_key

        # Two clients connected at the same time (e.g. two browser tabs).
        first_socket = _FakeWebSocket(messages=[])
        second_socket = _FakeWebSocket(messages=[])
        for socket in (first_socket, second_socket):
            env['connected_clients'].add(socket)
            env['client_subscriptions'][socket] = {}
            env['client_subscription_settings'][socket] = {'greeks_enabled': False}

        # First client: the same option contract requested under three ids
        # (e.g. finder template quote + legs in two combo groups).
        asyncio.run(dispatch_client_message(env, first_socket, {
            'action': 'subscribe',
            'underlying': {'secType': 'FUT', 'symbol': 'ES'},
            'options': [
                {'id': 'combo_template_ES_P_7550', 'secType': 'FOP', 'symbol': 'ES', 'strike': 7550, 'right': 'P'},
                {'id': 'leg_a', 'secType': 'FOP', 'symbol': 'ES', 'strike': 7550, 'right': 'P'},
                {'id': 'leg_b', 'secType': 'FOP', 'symbol': 'ES', 'strike': 7550, 'right': 'P'},
                {'id': 'leg_c', 'secType': 'FOP', 'symbol': 'ES', 'strike': 7600, 'right': 'C'},
            ],
            'futures': [],
            'stocks': [],
        }))

        option_calls = [call for call in env['ib'].req_mkt_data_calls if call[0].secType == 'FOP']
        self.assertEqual(len(option_calls), 2)

        first_subs = env['client_subscriptions'][first_socket]
        self.assertIs(first_subs['combo_template_ES_P_7550'], first_subs['leg_a'])
        self.assertIs(first_subs['leg_a'], first_subs['leg_b'])
        self.assertIsNot(first_subs['leg_a'], first_subs['leg_c'])

        # Second client asking for the same contract reuses the first client's
        # ticker instead of opening another TWS market data line.
        asyncio.run(dispatch_client_message(env, second_socket, {
            'action': 'subscribe',
            'underlying': {'secType': 'FUT', 'symbol': 'ES'},
            'options': [
                {'id': 'other_leg', 'secType': 'FOP', 'symbol': 'ES', 'strike': 7550, 'right': 'P'},
            ],
            'futures': [],
            'stocks': [],
        }))

        option_calls = [call for call in env['ib'].req_mkt_data_calls if call[0].secType == 'FOP']
        self.assertEqual(len(option_calls), 2)
        self.assertIs(env['client_subscriptions'][second_socket]['other_leg'], first_subs['leg_a'])

    def test_pooled_option_subscription_pushes_timing_without_waiting_for_a_quote(self):
        env, sent_messages, *_ = self._build_env()
        env['extract_quote_snapshot'] = lambda _ticker, _sec_type='': None
        env['option_contract_timing_by_con_id'] = {}

        async def qualify_spy_contract(contract, request=None):
            request_data = request if isinstance(request, dict) else {}
            sec_type = str(
                request_data.get('secType')
                or getattr(contract, 'secType', '')
                or 'STK'
            ).upper()
            if sec_type != 'OPT':
                return type('QualifiedUnderlying', (), {
                    'conId': 700,
                    'secType': 'STK',
                    'symbol': 'SPY',
                })()
            return type('QualifiedOption', (), {
                'conId': 701,
                'secType': 'OPT',
                'symbol': 'SPY',
                'localSymbol': 'SPY   260724P00750000',
                'lastTradeDateOrContractMonth': '20260724',
                'strike': 750.0,
                'right': 'P',
                'multiplier': '100',
                'exchange': 'SMART',
                'currency': 'USD',
                'tradingClass': 'SPY',
            })()

        async def resolve_timing(_qualified_option):
            return {
                'conId': 701,
                'secType': 'OPT',
                'symbol': 'SPY',
                'localSymbol': 'SPY   260724P00750000',
                'exchange': 'SMART',
                'currency': 'USD',
                'multiplier': '100',
                'tradingClass': 'SPY',
                'right': 'P',
                'strike': 750.0,
                'optionExpiry': '20260724',
                'contractIdentitySource': 'ib_contract_details',
                'expiryAsOf': '2026-07-24T20:00:00.000Z',
                'expiryTimingSource': 'ib_contract_details',
                'lastTradeDate': '20260724',
                'lastTradeTime': '16:00:00',
                'timeZoneId': 'US/Eastern',
                'realExpirationDate': '20260724',
            }

        env['qualify_one'] = qualify_spy_contract
        env['resolve_option_contract_timing'] = resolve_timing

        first_socket = _FakeWebSocket()
        second_socket = _FakeWebSocket()
        for socket in (first_socket, second_socket):
            env['client_subscriptions'][socket] = {}
            env['client_subscription_settings'][socket] = {'greeks_enabled': False}

        subscribe_data = {
            'action': 'subscribe',
            'underlying': {'secType': 'STK', 'symbol': 'SPY'},
            'options': [{
                'id': 'first_leg',
                'secType': 'OPT',
                'symbol': 'SPY',
                'expDate': '20260724',
                'strike': 750,
                'right': 'P',
            }],
            'futures': [],
            'stocks': [],
        }
        asyncio.run(dispatch_client_message(env, first_socket, subscribe_data))
        first_ticker = env['client_subscriptions'][first_socket]['first_leg']
        self.assertIsNone(env['extract_quote_snapshot'](first_ticker, 'OPT'))

        sent_messages.clear()
        second_data = dict(subscribe_data)
        second_data['options'] = [dict(subscribe_data['options'][0], id='second_leg')]
        asyncio.run(dispatch_client_message(env, second_socket, second_data))

        second_ticker = env['client_subscriptions'][second_socket]['second_leg']
        self.assertIs(second_ticker, first_ticker)
        metadata_payloads = [
            payload
            for socket, payload in sent_messages
            if socket is second_socket
            and payload.get('action') == 'option_contract_metadata'
            and payload.get('contractMetadataOnly') is True
            and 'second_leg' in (payload.get('options') or {})
        ]
        self.assertTrue(metadata_payloads)
        timing = metadata_payloads[-1]['options']['second_leg']
        self.assertEqual(timing['expiryAsOf'], '2026-07-24T20:00:00.000Z')
        for price_field in ('bid', 'ask', 'mark', 'iv', 'delta', 'quoteAsOf'):
            self.assertNotIn(price_field, timing)

    def test_single_expiry_spy_subscription_pushes_timing_for_every_leg(self):
        env, sent_messages, *_ = self._build_env()
        env['extract_quote_snapshot'] = lambda _ticker, _sec_type='': None
        env['option_contract_timing_by_con_id'] = {}
        option_identity_by_con_id = {}

        async def qualify_spy_leg(contract, request=None):
            request_data = request if isinstance(request, dict) else {}
            sec_type = str(
                request_data.get('secType')
                or getattr(contract, 'secType', '')
                or 'STK'
            ).upper()
            if sec_type != 'OPT':
                return type('QualifiedUnderlying', (), {
                    'conId': 800,
                    'secType': 'STK',
                    'symbol': 'SPY',
                })()
            strike = float(request_data['strike'])
            right = str(request_data['right']).upper()
            con_id = 810 + len(option_identity_by_con_id)
            qualified = type('QualifiedOption', (), {
                'conId': con_id,
                'secType': 'OPT',
                'symbol': 'SPY',
                'localSymbol': f'SPY 260724{right}{int(strike * 1000):08d}',
                'lastTradeDateOrContractMonth': '20260724',
                'strike': strike,
                'right': right,
                'multiplier': '100',
                'exchange': 'SMART',
                'currency': 'USD',
                'tradingClass': 'SPY',
            })()
            option_identity_by_con_id[con_id] = qualified
            return qualified

        async def resolve_timing(qualified_option):
            return {
                'conId': qualified_option.conId,
                'secType': 'OPT',
                'symbol': 'SPY',
                'localSymbol': qualified_option.localSymbol,
                'exchange': 'SMART',
                'currency': 'USD',
                'multiplier': '100',
                'tradingClass': 'SPY',
                'right': qualified_option.right,
                'strike': qualified_option.strike,
                'optionExpiry': '20260724',
                'contractIdentitySource': 'ib_contract_details',
                'expiryAsOf': '2026-07-24T20:00:00.000Z',
                'expiryTimingSource': 'ib_contract_details',
                'lastTradeDate': '20260724',
                'lastTradeTime': '16:00:00',
                'timeZoneId': 'US/Eastern',
                'realExpirationDate': '20260724',
            }

        env['qualify_one'] = qualify_spy_leg
        env['resolve_option_contract_timing'] = resolve_timing
        websocket = _FakeWebSocket()
        env['client_subscriptions'][websocket] = {}
        env['client_subscription_settings'][websocket] = {'greeks_enabled': False}
        requested_ids = ('spy_735_put', 'spy_750_put', 'spy_765_put')

        asyncio.run(dispatch_client_message(env, websocket, {
            'action': 'subscribe',
            'underlying': {'secType': 'STK', 'symbol': 'SPY'},
            'options': [
                {
                    'id': leg_id,
                    'secType': 'OPT',
                    'symbol': 'SPY',
                    'expDate': '20260724',
                    'strike': strike,
                    'right': 'P',
                }
                for leg_id, strike in zip(requested_ids, (735, 750, 765))
            ],
            'futures': [],
            'stocks': [],
        }))

        delivered = {}
        for socket, payload in sent_messages:
            if (socket is not websocket
                    or payload.get('action') != 'option_contract_metadata'
                    or payload.get('contractMetadataOnly') is not True):
                continue
            delivered.update(payload.get('options') or {})

        self.assertEqual(set(delivered), set(requested_ids))
        self.assertEqual(
            {quote.get('expiryAsOf') for quote in delivered.values()},
            {'2026-07-24T20:00:00.000Z'},
        )
        self.assertEqual(
            {quote.get('lastTradeDate') for quote in delivered.values()},
            {'20260724'},
        )
        self.assertEqual(
            {quote.get('conId') for quote in delivered.values()},
            {810, 811, 812},
        )
        for quote in delivered.values():
            for price_field in ('bid', 'ask', 'mark', 'iv', 'delta', 'quoteAsOf'):
                self.assertNotIn(price_field, quote)

    def test_handle_subscribe_upgrades_pooled_line_when_greeks_requested(self):
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

        sockets = [_FakeWebSocket(messages=[]) for _ in range(3)]
        for socket in sockets:
            env['connected_clients'].add(socket)
            env['client_subscriptions'][socket] = {}
            env['client_subscription_settings'][socket] = {'greeks_enabled': False}

        def subscribe(socket, greeks_enabled):
            asyncio.run(dispatch_client_message(env, socket, {
                'action': 'subscribe',
                'underlying': {'secType': 'FUT', 'symbol': 'ES'},
                'options': [
                    {'id': 'leg_x', 'secType': 'FOP', 'symbol': 'ES', 'strike': 7550, 'right': 'P'},
                ],
                'futures': [],
                'stocks': [],
                'greeksEnabled': greeks_enabled,
            }))

        def option_calls():
            return [call for call in env['ib'].req_mkt_data_calls if call[0].secType == 'FOP']

        # First client opens the shared line without greeks.
        subscribe(sockets[0], False)
        self.assertEqual(len(option_calls()), 1)
        self.assertEqual(option_calls()[0][1], '')

        # A greeks-enabled client must not silently reuse the greeks-less
        # line: the line is reopened once with the merged tick list.
        subscribe(sockets[1], True)
        self.assertEqual(len(env['ib'].cancel_mkt_data_calls), 1)
        self.assertEqual(len(option_calls()), 2)
        self.assertEqual(option_calls()[1][1], '106')
        second_ticker = env['client_subscriptions'][sockets[1]]['leg_x']
        self.assertEqual(getattr(second_ticker.contract, 'conId', None),
                         getattr(env['ib'].cancel_mkt_data_calls[0], 'conId', None))

        # Another greeks-enabled client reuses the upgraded line without churn.
        subscribe(sockets[2], True)
        self.assertEqual(len(env['ib'].cancel_mkt_data_calls), 1)
        self.assertEqual(len(option_calls()), 2)

    def test_sync_underlying_reuses_existing_pooled_line(self):
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

        first_socket = _FakeWebSocket(messages=[])
        second_socket = _FakeWebSocket(messages=[])
        for socket in (first_socket, second_socket):
            env['client_subscriptions'][socket] = {}
            env['client_subscription_settings'][socket] = {'greeks_enabled': False}

        asyncio.run(dispatch_client_message(env, first_socket, {
            'action': 'subscribe',
            'underlying': {'secType': 'FUT', 'symbol': 'ES'},
            'options': [],
            'futures': [],
            'stocks': [],
        }))

        self.assertEqual(len(env['ib'].req_mkt_data_calls), 1)
        first_ticker = env['client_subscriptions'][first_socket]['underlying']

        with patch('ib_server_ws.asyncio.sleep', new=AsyncMock()):
            asyncio.run(dispatch_client_message(env, second_socket, {
                'action': 'sync_underlying',
                'underlying': {'secType': 'FUT', 'symbol': 'ES'},
            }))

        self.assertEqual(len(env['ib'].req_mkt_data_calls), 1)
        self.assertEqual(len(env['ib'].cancel_mkt_data_calls), 0)
        self.assertIs(env['client_subscriptions'][first_socket]['underlying'], first_ticker)
        self.assertEqual(sent_messages[-1][1]['underlyingPrice'], 500.5)

    def test_sync_underlying_cancels_unshared_one_shot_line(self):
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

        websocket = _FakeWebSocket(messages=[])
        env['client_subscriptions'][websocket] = {}
        env['client_subscription_settings'][websocket] = {'greeks_enabled': False}

        with patch('ib_server_ws.asyncio.sleep', new=AsyncMock()):
            asyncio.run(dispatch_client_message(env, websocket, {
                'action': 'sync_underlying',
                'underlying': {'secType': 'STK', 'symbol': 'SPY'},
            }))

        self.assertEqual(len(env['ib'].req_mkt_data_calls), 1)
        self.assertEqual(env['ib'].req_mkt_data_calls[0][1], '')
        self.assertEqual(len(env['ib'].cancel_mkt_data_calls), 1)
        self.assertEqual(
            getattr(env['ib'].cancel_mkt_data_calls[0], 'conId', None),
            getattr(env['ib'].req_mkt_data_calls[0][0], 'conId', None),
        )
        self.assertEqual(env.get('market_data_generic_ticks_by_con_id', {}), {})
        self.assertEqual(sent_messages[-1][1]['underlyingPrice'], 500.5)

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
            'clientProtocolVersion': '20260719.5',
        })])
        handler = build_ws_client_handler(env)

        asyncio.run(handler(websocket))

        self.assertEqual(env['_captures']['iv_subscription_calls'], [(
            websocket,
            '127.0.0.1',
            {
                'action': 'subscribe_iv_term_structure',
                'underlying': {'secType': 'IND', 'symbol': 'SPX'},
                'clientProtocolVersion': '20260719.5',
            },
        )])
        started_payloads = [
            payload for _websocket, payload in env['_captures']['sent_messages']
            if payload.get('action') == 'iv_term_structure_sync_started'
        ]
        self.assertEqual(len(started_payloads), 1)
        self.assertEqual(started_payloads[0]['symbol'], 'SPX')
        self.assertEqual(started_payloads[0]['protocolVersion'], '20260719.5')
        self.assertIs(started_payloads[0]['accepted'], True)

    def test_iv_term_structure_protocol_mismatch_is_rejected_before_subscription(self):
        env, sent_messages, *_ = self._build_env()
        websocket = _FakeWebSocket()

        asyncio.run(dispatch_client_message(
            env,
            websocket,
            {
                'action': 'subscribe_iv_term_structure',
                'underlying': {'secType': 'IND', 'symbol': 'SPX'},
                'clientProtocolVersion': 'old-browser',
            },
        ))

        self.assertEqual(env['_captures']['iv_subscription_calls'], [])
        self.assertEqual(len(sent_messages), 1)
        payload = sent_messages[0][1]
        self.assertEqual(payload['action'], 'iv_term_structure_sync_started')
        self.assertIs(payload['accepted'], False)
        self.assertEqual(payload['protocolVersion'], '20260719.5')
        self.assertIn('protocol mismatch', payload['message'])

    def test_iv_term_structure_catalog_timeout_returns_explicit_error(self):
        env, sent_messages, *_ = self._build_env()
        websocket = _FakeWebSocket()
        # The dispatcher floors the timeout, so this lands at 1s, not 0.01s.
        # The stall must outlast that floor by enough that scheduling jitter
        # cannot let it win the race, but stay finite so a regressed timeout
        # fails here instead of hanging the suite.
        env['iv_term_structure_catalog_timeout_seconds'] = 0.01

        async def stalled_subscription(_websocket, _client_ip, _data):
            await asyncio.sleep(30)

        env['handle_iv_term_structure_subscription'] = stalled_subscription

        asyncio.run(dispatch_client_message(
            env,
            websocket,
            {
                'action': 'subscribe_iv_term_structure',
                'underlying': {'secType': 'FUT', 'symbol': 'CL'},
                'optionTemplate': {'symbol': 'CL'},
                'clientProtocolVersion': '20260719.5',
            },
            client_ip='10.0.0.8',
        ))

        self.assertEqual(len(sent_messages), 2)
        self.assertEqual(sent_messages[0][1]['action'], 'iv_term_structure_sync_started')
        payload = sent_messages[1][1]
        self.assertEqual(payload['action'], 'iv_term_structure_error')
        self.assertEqual(payload['symbol'], 'CL')
        self.assertIn('timed out', payload['message'])
        self.assertIn('2158', payload['message'])
        self.assertTrue(payload['payloadAsOf'])
        self.assertTrue(payload['batchId'])
        self.assertIs(payload['quoteComplete'], False)
        self.assertIs(payload['coherent'], False)
        self.assertEqual(payload['coherenceReason'], 'error_payload_no_quote_snapshot')

    def test_handle_ws_client_routes_active_combo_snapshot_action(self):
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
        websocket = _FakeWebSocket(messages=[json.dumps({'action': 'request_active_combo_orders_snapshot'})])
        handler = build_ws_client_handler(env)

        asyncio.run(handler(websocket))

        self.assertEqual(len(env['_captures']['active_combo_snapshot_calls']), 1)
        snapshot_messages = [
            payload for _ws, payload in sent_messages
            if payload.get('action') == 'active_combo_orders_snapshot'
        ]
        self.assertEqual(len(snapshot_messages), 1)

    def test_handle_ws_client_survives_malformed_and_failing_messages(self):
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

        class _ExplodingEngine(_ExecutionEngineStub):
            async def handle_hedge_action(self, websocket, data, client_ip='Unknown'):
                if data.get('action') == 'boom':
                    raise RuntimeError('handler bug')
                return await super().handle_hedge_action(websocket, data, client_ip=client_ip)

        env['execution_engine'] = _ExplodingEngine()
        websocket = _FakeWebSocket(messages=[
            'this is not json',
            json.dumps(['not', 'a', 'dict']),
            json.dumps({'action': 'boom'}),
            json.dumps({'action': 'request_ib_connection_status'}),
        ])
        handler = build_ws_client_handler(env)

        asyncio.run(handler(websocket))

        status_messages = [
            payload for _ws, payload in sent_messages
            if payload.get('action') == 'ib_connection_status'
        ]
        self.assertEqual(len(status_messages), 1)
        self.assertEqual(env['execution_engine'].cancel_calls, [websocket])

    def test_purge_combo_order_tracking_orphans_live_and_drops_terminal_entries(self):
        ws_target = object()
        ws_other = object()
        terminal_tracking = {'websocket': ws_target, 'orderId': 1, 'permId': 11, 'status': 'Filled'}
        live_tracking = {'websocket': ws_target, 'orderId': 2, 'permId': 22, 'status': 'Submitted'}
        other_tracking = {'websocket': ws_other, 'orderId': 3, 'permId': 33, 'status': 'Submitted'}
        by_order_id = {1: terminal_tracking, 2: live_tracking, 3: other_tracking}
        by_perm_id = {11: terminal_tracking, 22: live_tracking, 33: other_tracking}

        purge_combo_order_tracking_for_websocket(
            ws_target,
            by_order_id,
            by_perm_id,
            is_terminal_combo_tracking=lambda tracking: tracking.get('status') == 'Filled',
        )

        self.assertEqual(by_order_id, {2: live_tracking, 3: other_tracking})
        self.assertEqual(by_perm_id, {22: live_tracking, 33: other_tracking})
        self.assertIsNone(live_tracking['websocket'])
        self.assertIs(other_tracking['websocket'], ws_other)

    def test_purge_combo_order_tracking_orphans_everything_without_predicate(self):
        ws_target = object()
        live_tracking = {'websocket': ws_target, 'orderId': 2, 'permId': 22, 'status': 'Submitted'}
        by_order_id = {2: live_tracking}
        by_perm_id = {22: live_tracking}

        purge_combo_order_tracking_for_websocket(ws_target, by_order_id, by_perm_id)

        self.assertEqual(by_order_id, {2: live_tracking})
        self.assertEqual(by_perm_id, {22: live_tracking})
        self.assertIsNone(live_tracking['websocket'])

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


class _FakeMarkGreeks:
    def __init__(self, opt_price):
        self.optPrice = opt_price


class _FakeMarkTicker:
    def __init__(self, bid=float('nan'), ask=float('nan'), model_price=None,
                 last=float('nan'), close=float('nan')):
        self.bid = bid
        self.ask = ask
        self.last = last
        self.close = close
        self.modelGreeks = _FakeMarkGreeks(model_price) if model_price is not None else None

    def marketPrice(self):
        return float('nan')


class OptionMarkSourceTests(unittest.TestCase):
    """The implied-lambda estimator only accepts real two-sided mids, so the
    server must label where every option mark came from."""

    def test_two_sided_market_is_labeled_bid_ask_mid(self):
        mark, source = extract_option_mark_with_source(_FakeMarkTicker(bid=1.0, ask=1.2))
        self.assertEqual(mark, 1.1)
        self.assertEqual(source, 'bid_ask_mid')

    def test_zero_bid_is_a_real_two_sided_option_market(self):
        ticker = _FakeMarkTicker(bid=0, ask=0.2, model_price=0.04)
        ticker.contract = type('Contract', (), {'secType': 'OPT'})()

        mark, source = extract_option_mark_with_source(ticker)
        snapshot = extract_quote_snapshot(ticker, 'OPT')

        self.assertEqual(mark, 0.1)
        self.assertEqual(source, 'bid_ask_mid')
        self.assertEqual(snapshot['bid'], 0.0)
        self.assertEqual(snapshot['ask'], 0.2)
        self.assertEqual(snapshot['mark'], 0.1)
        self.assertEqual(snapshot['markSource'], 'bid_ask_mid')
        self.assertIs(snapshot['bidPresent'], True)
        self.assertIs(snapshot['askPresent'], True)
        self.assertIs(snapshot['bidAskValid'], True)
        self.assertEqual(snapshot['bidAskStatus'], 'two_sided')
        self.assertEqual(ticker_quote_fingerprint(ticker), ('bbo', 0.0, 0.2))

    def test_model_price_fallback_is_labeled_model(self):
        mark, source = extract_option_mark_with_source(_FakeMarkTicker(model_price=1.05))
        self.assertEqual(mark, 1.05)
        self.assertEqual(source, 'model')

    def test_last_close_fallback_is_labeled_last_close(self):
        mark, source = extract_option_mark_with_source(_FakeMarkTicker(last=0.95))
        self.assertEqual(mark, 0.95)
        self.assertEqual(source, 'last_close')

    def test_one_sided_book_falls_through_to_model(self):
        # A bid without an ask is not a two-sided market.
        mark, source = extract_option_mark_with_source(
            _FakeMarkTicker(bid=1.0, model_price=1.02)
        )
        self.assertEqual(mark, 1.02)
        self.assertEqual(source, 'model')

    def test_crossed_book_is_not_labeled_as_a_real_two_sided_mid(self):
        mark, source = extract_option_mark_with_source(
            _FakeMarkTicker(bid=1.2, ask=1.0, model_price=1.08)
        )
        self.assertEqual(mark, 1.08)
        self.assertEqual(source, 'model')

    def test_quote_snapshot_carries_mark_source_for_options(self):
        snapshot = extract_quote_snapshot(_FakeMarkTicker(model_price=2.5), 'FOP')
        self.assertEqual(snapshot['mark'], 2.5)
        self.assertEqual(snapshot['markSource'], 'model')
        self.assertIsNone(snapshot['bid'])
        self.assertIsNone(snapshot['ask'])
        self.assertIs(snapshot['bidPresent'], False)
        self.assertIs(snapshot['askPresent'], False)
        self.assertIs(snapshot['bidAskValid'], False)
        self.assertEqual(snapshot['bidAskStatus'], 'missing')

        two_sided = extract_quote_snapshot(_FakeMarkTicker(bid=2.4, ask=2.6), 'OPT')
        self.assertEqual(two_sided['markSource'], 'bid_ask_mid')

    def test_one_sided_option_keeps_only_the_real_side(self):
        snapshot = extract_quote_snapshot(
            _FakeMarkTicker(bid=1.0, model_price=1.02),
            'OPT',
        )

        self.assertEqual(snapshot['bid'], 1.0)
        self.assertIsNone(snapshot['ask'])
        self.assertEqual(snapshot['mark'], 1.02)
        self.assertEqual(snapshot['markSource'], 'model')
        self.assertIs(snapshot['bidPresent'], True)
        self.assertIs(snapshot['askPresent'], False)
        self.assertIs(snapshot['bidAskValid'], False)
        self.assertEqual(snapshot['bidAskStatus'], 'one_sided_bid')

    def test_crossed_option_keeps_sides_but_does_not_claim_valid_bbo(self):
        snapshot = extract_quote_snapshot(
            _FakeMarkTicker(bid=1.2, ask=1.0, model_price=1.08),
            'FOP',
        )

        self.assertEqual(snapshot['bid'], 1.2)
        self.assertEqual(snapshot['ask'], 1.0)
        self.assertEqual(snapshot['mark'], 1.08)
        self.assertEqual(snapshot['markSource'], 'model')
        self.assertIs(snapshot['bidPresent'], True)
        self.assertIs(snapshot['askPresent'], True)
        self.assertIs(snapshot['bidAskValid'], False)
        self.assertEqual(snapshot['bidAskStatus'], 'crossed')

    def test_completely_missing_option_quote_returns_none(self):
        self.assertIsNone(extract_quote_snapshot(_FakeMarkTicker(), 'OPT'))


class MarketReferenceContractMetadataTests(unittest.TestCase):
    def test_exact_futures_expiry_preserves_identity_and_enables_tenor(self):
        contract = type('Contract', (), {
            'conId': 12345,
            'secType': 'FUT',
            'symbol': 'ES',
            'localSymbol': 'ESU6',
            'exchange': 'CME',
            'currency': 'USD',
            'multiplier': '50',
            'lastTradeDateOrContractMonth': '20260918',
        })()

        metadata = extract_market_reference_contract_metadata(_FakeTicker(contract))

        self.assertEqual(metadata['conId'], 12345)
        self.assertEqual(metadata['symbol'], 'ES')
        self.assertEqual(metadata['localSymbol'], 'ESU6')
        self.assertEqual(metadata['currency'], 'USD')
        self.assertEqual(metadata['contractMonth'], '202609')
        self.assertEqual(metadata['lastTradeDate'], '20260918')

    def test_month_only_futures_label_does_not_invent_an_expiry_date(self):
        contract = type('Contract', (), {
            'secType': 'FUT',
            'symbol': 'CL',
            'lastTradeDateOrContractMonth': '202609',
        })()

        metadata = extract_market_reference_contract_metadata(_FakeTicker(contract))

        self.assertEqual(metadata['contractMonth'], '202609')
        self.assertEqual(metadata['contractMonthSource'], 'last_trade_date')
        self.assertNotIn('lastTradeDate', metadata)

    def test_energy_delivery_month_comes_from_contract_details_not_the_expiry(self):
        # CL Sep 2026 stops trading 2026-08-20.  Truncating that date reports
        # 202608 and made the browser reject every correctly qualified CL quote.
        contract = type('Contract', (), {
            'conId': 70102,
            'secType': 'FUT',
            'symbol': 'CL',
            'localSymbol': 'CLU6',
            'exchange': 'NYMEX',
            'currency': 'USD',
            'multiplier': '1000',
            'lastTradeDateOrContractMonth': '20260820',
        })()

        metadata = extract_market_reference_contract_metadata(
            _FakeTicker(contract), {70102: '202609'}
        )

        self.assertEqual(metadata['contractMonth'], '202609')
        self.assertEqual(metadata['contractMonthSource'], 'ib_contract_details')
        self.assertEqual(metadata['lastTradeDate'], '20260820')

    def test_unresolved_delivery_month_is_labelled_as_date_derived(self):
        contract = type('Contract', (), {
            'conId': 70102,
            'secType': 'FUT',
            'symbol': 'CL',
            'localSymbol': 'CLU6',
            'exchange': 'NYMEX',
            'currency': 'USD',
            'multiplier': '1000',
            'lastTradeDateOrContractMonth': '20260820',
        })()

        metadata = extract_market_reference_contract_metadata(_FakeTicker(contract), {})

        self.assertEqual(metadata['contractMonthSource'], 'last_trade_date')
        self.assertEqual(metadata['contractMonth'], '202608')


if __name__ == '__main__':
    unittest.main()
