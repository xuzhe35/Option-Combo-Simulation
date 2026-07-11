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
    normalize_max_option_streams,
    resolve_iv_term_structure_common_selections_from_candidates,
    run_iv_term_structure_option_sync,
    subscribe_iv_term_structure_option_request,
)


class _FakeOptionChain:
    def __init__(self, trading_class, expirations, strikes=(58.0, 59.0, 60.0), multiplier='5000', exchange='COMEX'):
        self.tradingClass = trading_class
        self.expirations = list(expirations)
        self.strikes = list(strikes)
        self.multiplier = multiplier
        self.exchange = exchange


class _FakeIB:
    def __init__(self, chains_by_con_id=None, contract_details_by_key=None):
        self.secdef_calls = []
        self.chains_by_con_id = dict(chains_by_con_id or {})
        self.contract_detail_calls = []
        self.contract_details_by_key = dict(contract_details_by_key or {})

    def isConnected(self):
        return True

    def reqMktData(self, contract, generic_ticks, snapshot, regulatory_snapshot):
        return type('Ticker', (), {'contract': contract})()

    async def reqSecDefOptParamsAsync(self, symbol, exchange, sec_type, con_id):
        self.secdef_calls.append((symbol, exchange, sec_type, con_id))
        return self.chains_by_con_id.get(con_id, [])

    async def reqContractDetailsAsync(self, contract):
        key = (
            getattr(contract, 'lastTradeDateOrContractMonth', ''),
            float(getattr(contract, 'strike', 0)),
        )
        self.contract_detail_calls.append(key)
        return self.contract_details_by_key.get(key, [])


class IvTermStructureBackendTests(unittest.TestCase):
    def test_option_stream_limit_keeps_complete_call_put_pairs(self):
        self.assertEqual(normalize_max_option_streams(None), 10)
        self.assertEqual(normalize_max_option_streams(11), 10)
        self.assertEqual(normalize_max_option_streams(20), 20)
        self.assertEqual(normalize_max_option_streams(0), 0)
        self.assertEqual(normalize_max_option_streams('all'), 0)

    def test_shared_atm_probe_uses_exact_nearest_strike_contracts(self):
        def detail(expiry, right, con_id):
            contract = type('QualifiedContract', (), {
                'conId': con_id,
                'lastTradeDateOrContractMonth': expiry,
                'strike': 750.0,
                'right': right,
                'multiplier': '100',
                'tradingClass': 'SPY',
            })()
            return type('ContractDetails', (), {'contract': contract})()

        fake_ib = _FakeIB(contract_details_by_key={
            ('20260717', 750.0): [
                detail('20260717', 'C', 101),
                detail('20260717', 'P', 102),
            ],
            ('20260724', 750.0): [
                detail('20260724', 'C', 103),
                detail('20260724', 'P', 104),
            ],
        })

        selections = asyncio.run(
            resolve_iv_term_structure_common_selections_from_candidates(
                {'ib': fake_ib},
                'SPY',
                'OPT',
                'SMART',
                'USD',
                '100',
                [
                    {'expiry': '20260717', 'dte': 7},
                    {'expiry': '20260724', 'dte': 14},
                ],
                750.25,
                [745.0, 750.0, 755.0],
                0,
            )
        )

        self.assertEqual(fake_ib.contract_detail_calls, [
            ('20260717', 750.0),
            ('20260724', 750.0),
        ])
        self.assertEqual(selections['20260717']['atm_strike'], 750.0)
        self.assertEqual(len(selections['20260717']['contractRows']), 2)
        self.assertEqual(len(selections['20260724']['contractRows']), 2)

    def test_option_qualification_timeout_returns_without_blocking_the_sync(self):
        websocket = object()
        fake_ib = _FakeIB()

        async def qualify_one(_contract, _request=None):
            await asyncio.sleep(1)
            return None

        env = {
            'ib': fake_ib,
            'client_subscriptions': {websocket: {}},
            'build_contract_from_request': lambda request: type('Contract', (), request)(),
            'qualify_one': qualify_one,
            'iv_term_structure_option_qualify_timeout_seconds': 0.01,
        }
        option_request = {
            'id': '__ivts__|SPY|20260717|750|C',
            'secType': 'OPT',
            'symbol': 'SPY',
            'exchange': 'SMART',
            'currency': 'USD',
            'multiplier': '100',
            'right': 'C',
            'strike': 750,
            'expDate': '20260717',
        }
        result_details = {}

        subscribed = asyncio.run(
            subscribe_iv_term_structure_option_request(
                env,
                websocket,
                option_request,
                result_details=result_details,
            )
        )

        self.assertFalse(subscribed)
        self.assertEqual(env['client_subscriptions'][websocket], {})
        self.assertEqual(result_details['kind'], 'qualification_timeout')
        self.assertIn('SPY 20260717 750C', result_details['message'])
        self.assertIn('timed out', result_details['message'])

    def test_reuses_contract_details_contract_without_requalifying_it(self):
        websocket = object()
        fake_ib = _FakeIB()
        qualified_contract = type('QualifiedContract', (), {'conId': 12345})()

        async def qualify_one(_contract, _request=None):
            raise AssertionError('qualification should be skipped for a resolved contract')

        env = {
            'ib': fake_ib,
            'client_subscriptions': {websocket: {}},
            'build_contract_from_request': lambda request: type('Contract', (), request)(),
            'qualify_one': qualify_one,
        }
        option_request = {
            'id': '__ivts__|ES|20260717|6300|C',
            'secType': 'FOP',
            'symbol': 'ES',
            'right': 'C',
            'strike': 6300,
            'expDate': '20260717',
        }

        subscribed = asyncio.run(
            subscribe_iv_term_structure_option_request(
                env,
                websocket,
                option_request,
                qualified_option=qualified_contract,
            )
        )

        self.assertTrue(subscribed)
        self.assertIs(
            env['client_subscriptions'][websocket][option_request['id']].contract,
            qualified_contract,
        )

    def test_background_sync_defaults_to_ten_streams_from_nearest_five_expiries(self):
        websocket = object()
        fake_ib = _FakeIB()
        sent_messages = []
        con_id = 20000
        probed_expiries = []

        async def send_message_safe(_websocket, message):
            sent_messages.append(json.loads(message))

        async def resolve_common_selections(
            _env,
            _option_symbol,
            _option_sec_type,
            _option_exchange,
            _option_currency,
            _option_multiplier,
            expiry_rows,
            _underlying_price,
            _candidate_strikes,
            _strike_radius,
            **_kwargs,
        ):
            nonlocal con_id
            selections = {}
            for expiry_row in expiry_rows:
                expiry = expiry_row['expiry']
                probed_expiries.append(expiry)
                rows = []
                for right in ('C', 'P'):
                    con_id += 1
                    contract = type('QualifiedContract', (), {
                        'conId': con_id,
                        'secType': 'OPT',
                        'symbol': 'SPY',
                        'lastTradeDateOrContractMonth': expiry,
                        'strike': 750.0,
                        'right': right,
                    })()
                    rows.append({
                        'expiry': expiry,
                        'strike': 750.0,
                        'right': right,
                        'tradingClass': 'SPY',
                        'contract': contract,
                    })
                selections[expiry] = {
                    'atm_strike': 750.0,
                    'window_strikes': [750.0],
                    'tradingClass': 'SPY',
                    'contractRows': rows,
                }
            return selections

        async def qualify_one(_contract, _request=None):
            raise AssertionError('resolved option contracts should not be requalified')

        env = {
            'ib': fake_ib,
            'client_subscriptions': {websocket: {}},
            'iv_term_structure_sync_tasks': {},
            'send_message_safe': send_message_safe,
            'build_contract_from_request': lambda request: type('Contract', (), request)(),
            'qualify_one': qualify_one,
            'coerce_positive_int': lambda value, default: int(value or default),
            'iv_term_structure_default_strike_radius': 1,
            'iv_term_structure_bucket_definitions': [],
        }
        sync_context = {
            'expiryRows': [
                {'expiry': '20260717', 'dte': 7},
                {'expiry': '20260724', 'dte': 14},
                {'expiry': '20260731', 'dte': 21},
                {'expiry': '20260807', 'dte': 28},
                {'expiry': '20260814', 'dte': 35},
                {'expiry': '20260821', 'dte': 42},
            ],
            'optionSymbol': 'SPY',
            'optionSecType': 'OPT',
            'optionExchange': 'SMART',
            'optionCurrency': 'USD',
            'optionMultiplier': '100',
            'underlyingSymbol': 'SPY',
            'underlyingExchange': 'SMART',
            'underlyingPrice': 750.25,
            'strikeRadius': 1,
            'globalCandidateStrikes': [750.0],
        }

        with patch(
            'ib_server_iv_term_structure.resolve_iv_term_structure_common_selections_from_candidates',
            new=resolve_common_selections,
        ):
            asyncio.run(
                run_iv_term_structure_option_sync(env, websocket, 'SPY', sync_context)
            )

        complete = sent_messages[-1]
        self.assertEqual(complete['action'], 'iv_term_structure_sync_complete')
        self.assertEqual(complete['expectedOptionCount'], 10)
        self.assertEqual(complete['attemptedOptionCount'], 10)
        self.assertEqual(complete['subscribedOptionCount'], 10)
        self.assertEqual(complete['failedOptionCount'], 0)
        self.assertEqual(complete['timedOutOptionCount'], 0)
        self.assertEqual(complete['subscriptionErrorMessage'], '')
        self.assertEqual(len(env['client_subscriptions'][websocket]), 10)
        self.assertEqual(probed_expiries, [
            '20260717',
            '20260724',
            '20260731',
            '20260807',
            '20260814',
        ])
        patched_rows = [
            row
            for payload in sent_messages
            if payload.get('action') == 'iv_term_structure_catalog_patch'
            for row in payload.get('expiryRows') or []
        ]
        self.assertEqual(len(patched_rows), 6)
        self.assertEqual(sum(row['subscriptionSelected'] is True for row in patched_rows), 5)
        self.assertEqual(sum(row['subscriptionSelected'] is False for row in patched_rows), 1)

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
