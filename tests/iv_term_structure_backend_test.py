import asyncio
import json
import pathlib
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

try:
    import ib_async  # noqa: F401
except ModuleNotFoundError:
    ib_async_stub = types.ModuleType('ib_async')

    class Contract:
        def __init__(self, **kwargs):
            for key, value in kwargs.items():
                setattr(self, key, value)

    ib_async_stub.Contract = Contract
    sys.modules['ib_async'] = ib_async_stub


from ib_server_iv_term_structure import (
    handle_iv_term_structure_subscription,
    merge_iv_term_structure_chain_fields,
)


class _FakeOptionChain:
    def __init__(self, trading_class, expirations, strikes=(58.0, 59.0, 60.0), multiplier='5000', exchange='COMEX'):
        self.tradingClass = trading_class
        self.expirations = list(expirations)
        self.strikes = list(strikes)
        self.multiplier = multiplier
        self.exchange = exchange


class _FakeIB:
    def __init__(self, chains_by_con_id=None):
        self.secdef_calls = []
        self.chains_by_con_id = dict(chains_by_con_id or {})

    def isConnected(self):
        return True

    def reqMktData(self, contract, generic_ticks, snapshot, regulatory_snapshot):
        return type('Ticker', (), {'contract': contract})()

    async def reqSecDefOptParamsAsync(self, symbol, exchange, sec_type, con_id):
        self.secdef_calls.append((symbol, exchange, sec_type, con_id))
        return self.chains_by_con_id.get(con_id, [])


class IvTermStructureBackendTests(unittest.TestCase):
    def test_fop_underlying_request_uses_template_multiplier_to_avoid_si_ambiguity(self):
        websocket = object()
        fake_ib = _FakeIB({
            505405746: [_FakeOptionChain('S3T', ['20260721'])],
        })
        sent_messages = []
        captured_underlying_requests = []
        settings = {}

        async def send_message_safe(_websocket, message):
            sent_messages.append(json.loads(message))

        def build_contract_from_request(request):
            captured_underlying_requests.append(dict(request))
            return type('Contract', (), {
                'secType': request.get('secType'),
                'symbol': request.get('symbol'),
                'lastTradeDateOrContractMonth': request.get('contractMonth'),
                'multiplier': request.get('multiplier'),
            })()

        async def qualify_one(contract, request=None):
            return type('QualifiedContract', (), {
                'conId': 505405746,
                'secType': getattr(contract, 'secType', 'FUT'),
                'symbol': getattr(contract, 'symbol', 'SI'),
            })()

        env = {
            'ib': fake_ib,
            'client_subscriptions': {websocket: {}},
            'client_subscription_settings': {},
            'iv_term_structure_sync_tasks': {},
            'send_message_safe': send_message_safe,
            'build_underlying_request': lambda raw_underlying, _options: raw_underlying,
            'build_contract_from_request': build_contract_from_request,
            'qualify_one': qualify_one,
            'unsubscribe_client_safely': lambda _websocket: None,
            'get_client_subscription_settings': lambda _websocket: settings.setdefault(
                _websocket,
                {'greeks_enabled': True},
            ),
            'extract_quote_snapshot': lambda _ticker, _sec_type='': {
                'bid': 28.0,
                'ask': 28.1,
                'mark': 28.05,
            },
            'describe_contract_request': lambda request: f"{request.get('secType')} {request.get('symbol')}",
            'coerce_positive_int': lambda value, default: int(value or default),
            'normalize_replay_date': lambda value: value,
            'iv_term_structure_default_max_dte': 200,
            'iv_term_structure_default_strike_radius': 1,
            'iv_term_structure_bucket_definitions': [],
        }

        data = {
            'underlying': {
                'secType': 'FUT',
                'symbol': 'SI',
                'exchange': 'COMEX',
                'currency': 'USD',
                'contractMonth': '202608',
            },
            'optionTemplate': {
                'secType': 'FOP',
                'symbol': 'SI',
                'underlyingSymbol': 'SI',
                'exchange': 'COMEX',
                'underlyingExchange': 'COMEX',
                'currency': 'USD',
                'multiplier': '5000',
                'underlyingMultiplier': '5000',
                'underlyingContractMonth': '202608',
                'tradingClass': 'S3T',
            },
            'anchorDate': '2026-06-27',
            'maxDte': 200,
            'strikeRadius': 1,
        }

        with patch('ib_server_iv_term_structure.asyncio.sleep', new=AsyncMock()), \
             patch('ib_server_iv_term_structure.track_iv_term_structure_sync_task', lambda _env, _websocket, task: task.cancel()):
            asyncio.run(handle_iv_term_structure_subscription(env, websocket, '127.0.0.1', data))

        self.assertEqual(captured_underlying_requests[0]['contractMonth'], '202608')
        self.assertEqual(captured_underlying_requests[0]['multiplier'], '5000')
        self.assertEqual(captured_underlying_requests[0]['currency'], 'USD')
        self.assertEqual(fake_ib.secdef_calls, [('SI', 'COMEX', 'FUT', 505405746)])
        self.assertEqual(sent_messages[0]['action'], 'iv_term_structure_snapshot')

    def test_fop_chain_merge_does_not_filter_to_one_requested_trading_class(self):
        merged = merge_iv_term_structure_chain_fields(
            [
                _FakeOptionChain('S3T', ['20260721']),
                _FakeOptionChain('SO', ['20260728', '20260826']),
                _FakeOptionChain('W1S', ['20260701']),
            ],
            {
                'secType': 'FOP',
                'exchange': 'COMEX',
                'multiplier': '5000',
                'tradingClass': 'S3T',
            },
        )

        self.assertEqual(
            merged['expirations'],
            ['20260701', '20260721', '20260728', '20260826'],
        )
        self.assertEqual(merged['tradingClass'], '')

    def test_fop_subscription_rolls_to_next_underlying_month_with_expiries(self):
        websocket = object()
        con_id_by_month = {
            '202607': 1007,
            '202608': 1008,
            '202609': 1009,
        }
        fake_ib = _FakeIB({
            1007: [],
            1008: [],
            1009: [
                _FakeOptionChain('S3T', ['20260721']),
                _FakeOptionChain('SO', ['20260728', '20260826']),
            ],
        })
        sent_messages = []
        captured_underlying_requests = []
        settings = {}

        async def send_message_safe(_websocket, message):
            sent_messages.append(json.loads(message))

        def build_contract_from_request(request):
            captured_underlying_requests.append(dict(request))
            return type('Contract', (), {
                'secType': request.get('secType'),
                'symbol': request.get('symbol'),
                'lastTradeDateOrContractMonth': request.get('contractMonth'),
                'multiplier': request.get('multiplier'),
            })()

        async def qualify_one(contract, request=None):
            request_data = request if isinstance(request, dict) else {}
            contract_month = request_data.get('contractMonth')
            con_id = con_id_by_month.get(contract_month)
            if con_id is None:
                return None
            return type('QualifiedContract', (), {
                'conId': con_id,
                'secType': getattr(contract, 'secType', 'FUT'),
                'symbol': getattr(contract, 'symbol', 'SI'),
            })()

        env = {
            'ib': fake_ib,
            'client_subscriptions': {websocket: {}},
            'client_subscription_settings': {},
            'iv_term_structure_sync_tasks': {},
            'send_message_safe': send_message_safe,
            'build_underlying_request': lambda raw_underlying, _options: raw_underlying,
            'build_contract_from_request': build_contract_from_request,
            'qualify_one': qualify_one,
            'unsubscribe_client_safely': lambda _websocket: None,
            'get_client_subscription_settings': lambda _websocket: settings.setdefault(
                _websocket,
                {'greeks_enabled': True},
            ),
            'extract_quote_snapshot': lambda _ticker, _sec_type='': {
                'bid': 59.0,
                'ask': 59.1,
                'mark': 59.05,
            },
            'describe_contract_request': lambda request: f"{request.get('secType')} {request.get('symbol')}",
            'coerce_positive_int': lambda value, default: int(value or default),
            'normalize_replay_date': lambda value: value,
            'iv_term_structure_default_max_dte': 200,
            'iv_term_structure_default_strike_radius': 1,
            'iv_term_structure_bucket_definitions': [],
        }

        data = {
            'underlying': {
                'secType': 'FUT',
                'symbol': 'SI',
                'exchange': 'COMEX',
                'currency': 'USD',
                'contractMonth': '202607',
                'multiplier': '5000',
            },
            'optionTemplate': {
                'secType': 'FOP',
                'symbol': 'SI',
                'underlyingSymbol': 'SI',
                'exchange': 'COMEX',
                'underlyingExchange': 'COMEX',
                'currency': 'USD',
                'multiplier': '5000',
                'underlyingMultiplier': '5000',
                'underlyingContractMonth': '202607',
                'tradingClass': 'S3T',
            },
            'anchorDate': '2026-06-27',
            'maxDte': 200,
            'strikeRadius': 1,
        }

        with patch('ib_server_iv_term_structure.asyncio.sleep', new=AsyncMock()), \
             patch('ib_server_iv_term_structure.track_iv_term_structure_sync_task', lambda _env, _websocket, task: task.cancel()):
            asyncio.run(handle_iv_term_structure_subscription(env, websocket, '127.0.0.1', data))

        snapshot = sent_messages[0]
        self.assertEqual(snapshot['action'], 'iv_term_structure_snapshot')
        self.assertEqual(snapshot['requestedUnderlyingContractMonth'], '202607')
        self.assertEqual(snapshot['underlyingContractMonth'], '202609')
        self.assertIn('using SI 202609 instead', snapshot['message'])
        self.assertEqual([call[3] for call in fake_ib.secdef_calls], [1007, 1008, 1009])
        self.assertEqual(captured_underlying_requests[-1]['contractMonth'], '202609')


if __name__ == '__main__':
    unittest.main()
