import asyncio
import json
import pathlib
import sys
import types
import unittest
from datetime import datetime, timezone
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
    fetch_iv_term_structure_contract_rows_for_expiry,
    fetch_iv_term_structure_contract_rows_for_exact_strike,
    handle_iv_term_structure_subscription,
    merge_iv_term_structure_chain_fields,
    normalize_max_option_streams,
    resolve_iv_term_structure_common_selections_from_candidates,
    run_iv_term_structure_option_sync,
    subscribe_iv_term_structure_option_request,
)
from ib_server_market_data import (
    IV_TERM_STRUCTURE_SNAPSHOT_STATE_KEY,
    build_option_contract_timing,
    build_iv_term_structure_quote_snapshot,
    build_pending_tickers_handler,
    record_ticker_quote_as_of,
    ticker_quote_as_of,
    ticker_quote_evidence_key,
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
    def assert_server_time_evidence(self, payload, reason=None):
        parsed = datetime.fromisoformat(payload['payloadAsOf'].replace('Z', '+00:00'))
        self.assertEqual(parsed.utcoffset(), timezone.utc.utcoffset(parsed))
        self.assertTrue(payload['batchId'])
        self.assertIs(payload['quoteComplete'], False)
        self.assertIs(payload['coherent'], False)
        if reason is not None:
            self.assertEqual(payload['coherenceReason'], reason)

    def test_option_stream_limit_keeps_complete_call_put_pairs(self):
        self.assertEqual(normalize_max_option_streams(None), 20)
        self.assertEqual(normalize_max_option_streams(11), 10)
        self.assertEqual(normalize_max_option_streams(20), 20)
        self.assertEqual(normalize_max_option_streams(0), 0)
        self.assertEqual(normalize_max_option_streams('all'), 0)

    def test_iv_term_structure_error_is_generation_stamped(self):
        websocket = object()
        sent_messages = []

        async def send_message_safe(_websocket, message):
            sent_messages.append(json.loads(message))

        env = {
            'ib': types.SimpleNamespace(isConnected=lambda: False),
            'send_message_safe': send_message_safe,
            'get_api_market_data_generation': lambda: 45,
            'api_market_data_reset_in_progress': lambda: False,
        }
        asyncio.run(handle_iv_term_structure_subscription(
            env,
            websocket,
            '127.0.0.1',
            {'underlying': {'symbol': 'SPX'}},
        ))

        self.assertEqual(len(sent_messages), 1)
        self.assertEqual(sent_messages[0]['action'], 'iv_term_structure_error')
        self.assertEqual(sent_messages[0]['marketDataGeneration'], 45)

    def test_contract_last_trade_timing_uses_exchange_zone_and_not_real_expiration_date(self):
        contract = types.SimpleNamespace(
            conId=101,
            secType='FOP',
            symbol='ES',
            localSymbol='ES   260717C07500000',
            exchange='CME',
            currency='USD',
            multiplier='50',
            tradingClass='EW3',
            right='C',
            strike=7500.0,
            lastTradeDateOrContractMonth='20260717',
            # This is only a local request hint. ContractDetails below is the
            # authoritative source and must override it.
            underConId=999,
        )
        summer = types.SimpleNamespace(
            contract=contract,
            underConId=70001,
            lastTradeTime='15:00:00',
            timeZoneId='US/Central',
            realExpirationDate='20260718',
        )
        summer_timing = build_option_contract_timing(contract, summer)
        self.assertEqual(summer_timing['expiryAsOf'], '2026-07-17T20:00:00.000Z')
        self.assertEqual(summer_timing['lastTradeDate'], '20260717')
        self.assertEqual(summer_timing['realExpirationDate'], '20260718')
        self.assertEqual(summer_timing['conId'], 101)
        self.assertEqual(summer_timing['localSymbol'], 'ES   260717C07500000')
        self.assertEqual(summer_timing['tradingClass'], 'EW3')
        self.assertEqual(summer_timing['right'], 'C')
        self.assertEqual(summer_timing['strike'], 7500.0)
        self.assertEqual(summer_timing['optionExpiry'], '20260717')
        self.assertEqual(summer_timing['underConId'], 70001)
        self.assertEqual(summer_timing['contractIdentitySource'], 'ib_contract_details')

        winter_contract = types.SimpleNamespace(
            conId=102,
            lastTradeDateOrContractMonth='20261218',
        )
        winter = types.SimpleNamespace(
            contract=winter_contract,
            lastTradeTime='15:00:00',
            timeZoneId='US/Central',
            realExpirationDate='20261218',
        )
        self.assertEqual(
            build_option_contract_timing(winter_contract, winter)['expiryAsOf'],
            '2026-12-18T21:00:00.000Z',
        )

        missing_time = types.SimpleNamespace(
            contract=contract,
            lastTradeTime='',
            timeZoneId='US/Central',
            realExpirationDate='20260717',
        )
        self.assertNotIn('expiryAsOf', build_option_contract_timing(contract, missing_time))

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

    def test_fop_contract_rows_filter_on_contract_details_under_con_id(self):
        def detail(con_id, under_con_id):
            contract = type('QualifiedContract', (), {
                'conId': con_id,
                'lastTradeDateOrContractMonth': '20260717',
                'strike': 7500.0,
                'right': 'C',
                'multiplier': '50',
                'tradingClass': 'EW3',
            })()
            return type('ContractDetails', (), {
                'contract': contract,
                'underConId': under_con_id,
            })()

        fake_ib = _FakeIB(contract_details_by_key={
            ('20260717', 7500.0): [
                detail(501, 70001),
                detail(502, 70002),
            ],
        })

        rows = asyncio.run(fetch_iv_term_structure_contract_rows_for_exact_strike(
            {'ib': fake_ib},
            'ES',
            'FOP',
            'CME',
            'USD',
            '50',
            '20260717',
            7500.0,
            qualified_underlying=types.SimpleNamespace(conId=70002),
        ))

        self.assertEqual([row['contract'].conId for row in rows], [502])

    def test_fop_contract_rows_reject_details_without_under_con_id(self):
        contract = types.SimpleNamespace(
            conId=503,
            lastTradeDateOrContractMonth='20260717',
            strike=7500.0,
            right='C',
            multiplier='50',
            tradingClass='EW3',
        )
        detail_without_underlying = types.SimpleNamespace(contract=contract)
        fake_ib = _FakeIB(contract_details_by_key={
            ('20260717', 0.0): [detail_without_underlying],
            ('20260717', 7500.0): [detail_without_underlying],
        })
        arguments = (
            {'ib': fake_ib},
            'ES',
            'FOP',
            'CME',
            'USD',
            '50',
            '20260717',
        )
        qualified_underlying = types.SimpleNamespace(conId=70002)

        expiry_rows = asyncio.run(fetch_iv_term_structure_contract_rows_for_expiry(
            *arguments,
            qualified_underlying=qualified_underlying,
        ))
        exact_rows = asyncio.run(fetch_iv_term_structure_contract_rows_for_exact_strike(
            *arguments,
            7500.0,
            qualified_underlying=qualified_underlying,
        ))

        self.assertEqual(expiry_rows, [])
        self.assertEqual(exact_rows, [])

    def test_contract_detail_requests_share_a_global_concurrency_limit(self):
        class ConcurrencyIB:
            def __init__(self):
                self.active = 0
                self.max_active = 0

            async def reqContractDetailsAsync(self, _contract):
                self.active += 1
                self.max_active = max(self.max_active, self.active)
                try:
                    await asyncio.sleep(0.01)
                    return []
                finally:
                    self.active -= 1

        fake_ib = ConcurrencyIB()
        env = {
            'ib': fake_ib,
            'iv_term_structure_contract_details_semaphore': asyncio.Semaphore(1),
        }

        async def exercise():
            await asyncio.gather(
                fetch_iv_term_structure_contract_rows_for_exact_strike(
                    env, 'SPY', 'OPT', 'SMART', 'USD', '100', '20260717', 750,
                ),
                fetch_iv_term_structure_contract_rows_for_exact_strike(
                    env, 'CL', 'FOP', 'NYMEX', 'USD', '1000', '20260717', 75,
                ),
            )

        asyncio.run(exercise())

        self.assertEqual(fake_ib.max_active, 1)

    def test_equity_chain_merge_skips_adjusted_trading_classes_when_standard_chain_exists(self):
        merged = merge_iv_term_structure_chain_fields(
            [
                _FakeOptionChain(
                    'SPY',
                    ['20260828', '20260831', '20260918'],
                    multiplier='100',
                    exchange='SMART',
                ),
                _FakeOptionChain(
                    '2SPY',
                    ['20260911'],
                    multiplier='100',
                    exchange='SMART',
                ),
            ],
            {
                'secType': 'OPT',
                'symbol': 'SPY',
                'exchange': 'SMART',
                'multiplier': '100',
            },
        )

        self.assertEqual(
            merged['expirations'],
            ['20260828', '20260831', '20260918'],
        )
        self.assertEqual(merged['tradingClass'], 'SPY')

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

    def test_background_sync_defaults_to_twenty_streams_and_keeps_all_six_available_expiries(self):
        websocket = object()
        fake_ib = _FakeIB()
        sent_messages = []
        settings = {
            websocket: {
                'greeks_enabled': False,
                IV_TERM_STRUCTURE_SNAPSHOT_STATE_KEY: {
                    'stateId': 'sync-state-1',
                    'subscriptionComplete': False,
                    'expectedOptionIds': [],
                    'subscribedOptionIds': [],
                },
            },
        }
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
            'client_subscription_settings': settings,
            'get_api_market_data_generation': lambda: 41,
            'api_market_data_reset_in_progress': lambda: False,
            'get_client_subscription_settings': lambda socket: settings[socket],
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
            'snapshotStateId': 'sync-state-1',
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
        self.assertEqual(complete['marketDataGeneration'], 41)
        self.assert_server_time_evidence(
            complete,
            'subscriptions_ready_without_coherent_quote_snapshot',
        )
        self.assertEqual(complete['expectedOptionCount'], 12)
        self.assertEqual(complete['attemptedOptionCount'], 12)
        self.assertEqual(complete['subscribedOptionCount'], 12)
        self.assertEqual(complete['failedOptionCount'], 0)
        self.assertEqual(complete['timedOutOptionCount'], 0)
        self.assertEqual(complete['subscriptionErrorMessage'], '')
        self.assertEqual(len(env['client_subscriptions'][websocket]), 12)
        self.assertEqual(probed_expiries, [
            '20260717',
            '20260724',
            '20260731',
            '20260807',
            '20260814',
            '20260821',
        ])
        patched_rows = [
            row
            for payload in sent_messages
            if payload.get('action') == 'iv_term_structure_catalog_patch'
            for row in payload.get('expiryRows') or []
        ]
        self.assertEqual(len(patched_rows), 6)
        self.assertEqual(sum(row['subscriptionSelected'] is True for row in patched_rows), 6)
        self.assertEqual(sum(row['subscriptionSelected'] is False for row in patched_rows), 0)
        snapshot_state = settings[websocket][IV_TERM_STRUCTURE_SNAPSHOT_STATE_KEY]
        self.assertIs(snapshot_state['subscriptionComplete'], True)
        self.assertEqual(snapshot_state['expectedOptionCount'], 12)
        self.assertEqual(snapshot_state['subscribedOptionCount'], 12)
        self.assertEqual(
            set(snapshot_state['expectedOptionIds']),
            set(snapshot_state['subscribedOptionIds']),
        )
        for catalog_patch in (
            payload
            for payload in sent_messages
            if payload.get('action') == 'iv_term_structure_catalog_patch'
        ):
            self.assertEqual(catalog_patch['marketDataGeneration'], 41)
            self.assert_server_time_evidence(
                catalog_patch,
                'catalog_progress_without_complete_option_quotes',
            )

    def test_incremental_live_ivts_quotes_carry_per_leg_server_time_and_fail_closed(self):
        websocket = object()
        sent_messages = []

        def option_ticker(con_id, bid, ask, right):
            contract = type('Contract', (), {
                'conId': con_id,
                'secType': 'FOP',
                'symbol': 'ES',
                'localSymbol': f'ES   260717{right}07500000',
                'exchange': 'CME',
                'currency': 'USD',
                'multiplier': '50',
                'tradingClass': 'EW3',
                'right': right,
                'strike': 7500.0,
                'lastTradeDateOrContractMonth': '20260717',
            })()
            greeks = type('Greeks', (), {'impliedVol': 0.2})()
            return type('Ticker', (), {
                'contract': contract,
                'bid': bid,
                'ask': ask,
                'modelGreeks': greeks,
                'ticks': [type('Tick', (), {'tickType': 1})()],
            })()

        changed_ticker = option_ticker(101, 1.0, 1.2, 'C')
        unchanged_ticker = option_ticker(102, 2.0, 2.2, 'P')

        async def send_message_safe(_websocket, message):
            sent_messages.append(json.loads(message))

        env = {
            'connected_clients': {websocket},
            'client_subscriptions': {
                websocket: {
                    '__ivts__|SPY|20260717|750|C': changed_ticker,
                    '__ivts__|SPY|20260717|750|P': unchanged_ticker,
                },
            },
            'client_subscription_settings': {},
            'option_contract_timing_by_con_id': {
                101: {
                    'expiryAsOf': '2026-07-17T20:00:00.000Z',
                    'expiryTimingSource': 'ib_contract_details',
                    'lastTradeDate': '20260717',
                    'underConId': 70001,
                    'underlyingContractMonth': '202609',
                    'underlyingBindingVerified': True,
                    'underlyingBindingSource': 'ib_contract_details_under_con_id',
                    'underlyingBindingStatus': 'verified',
                },
            },
            'send_message_safe': send_message_safe,
            'log_option_iv_debug_if_needed': lambda *_args: None,
            'get_api_market_data_generation': lambda: 42,
            'api_market_data_reset_in_progress': lambda: False,
        }
        handler = build_pending_tickers_handler(env)

        async def exercise_handler():
            handler([changed_ticker])
            await asyncio.sleep(0)

        asyncio.run(exercise_handler())

        self.assertEqual(len(sent_messages), 1)
        payload = sent_messages[0]
        self.assertEqual(payload['marketDataGeneration'], 42)
        self.assert_server_time_evidence(
            payload,
            'incremental_changed_tickers_only',
        )
        self.assertEqual(
            list(payload['options']),
            ['__ivts__|SPY|20260717|750|C'],
        )
        changed_quote = payload['options']['__ivts__|SPY|20260717|750|C']
        self.assertEqual(changed_quote['quoteAsOf'], payload['payloadAsOf'])
        self.assertEqual(changed_quote['mark'], 1.1)
        self.assertEqual(changed_quote['expiryAsOf'], '2026-07-17T20:00:00.000Z')
        self.assertEqual(changed_quote['lastTradeDate'], '20260717')
        self.assertEqual(changed_quote['conId'], 101)
        self.assertEqual(changed_quote['secType'], 'FOP')
        self.assertEqual(changed_quote['symbol'], 'ES')
        self.assertEqual(changed_quote['localSymbol'], 'ES   260717C07500000')
        self.assertEqual(changed_quote['tradingClass'], 'EW3')
        self.assertEqual(changed_quote['right'], 'C')
        self.assertEqual(changed_quote['strike'], 7500.0)
        self.assertEqual(changed_quote['optionExpiry'], '20260717')
        self.assertEqual(changed_quote['underConId'], 70001)
        self.assertEqual(changed_quote['underlyingContractMonth'], '202609')
        self.assertIs(changed_quote['underlyingBindingVerified'], True)

    def test_pending_ticker_send_is_suppressed_if_generation_changes_before_task_runs(self):
        websocket = object()
        sent_messages = []
        generation = [44]
        contract = types.SimpleNamespace(
            conId=4401,
            secType='STK',
            symbol='SPY',
        )
        ticker = types.SimpleNamespace(
            contract=contract,
            bid=500.0,
            ask=500.2,
            last=500.1,
            close=499.0,
            ticks=[types.SimpleNamespace(tickType=1)],
            marketPrice=lambda: 500.1,
        )

        async def send_message_safe(_websocket, message):
            sent_messages.append(json.loads(message))

        env = {
            'connected_clients': {websocket},
            'client_subscriptions': {websocket: {'underlying': ticker}},
            'client_subscription_settings': {
                websocket: {'greeks_enabled': False},
            },
            'send_message_safe': send_message_safe,
            'log_option_iv_debug_if_needed': lambda *_args: None,
            'get_api_market_data_generation': lambda: generation[0],
            'api_market_data_reset_in_progress': lambda: False,
        }
        handler = build_pending_tickers_handler(env)

        async def exercise_handler():
            handler([ticker])
            generation[0] += 1
            await asyncio.sleep(0)

        asyncio.run(exercise_handler())

        self.assertEqual(sent_messages, [])

    def test_pending_tickers_emits_one_complete_coherent_ivts_snapshot(self):
        websocket = object()
        sent_messages = []

        def ticker(con_id, sec_type, bid, ask, iv=None):
            contract = type('Contract', (), {
                'conId': con_id,
                'secType': sec_type,
                'symbol': 'SPY',
            })()
            greeks = type('Greeks', (), {
                'impliedVol': iv,
                'optPrice': None,
            })() if iv is not None else None
            return type('Ticker', (), {
                'contract': contract,
                'bid': bid,
                'ask': ask,
                'last': (bid + ask) / 2,
                'close': (bid + ask) / 2,
                'modelGreeks': greeks,
                'ticks': [type('Tick', (), {'tickType': 1})()],
                'marketPrice': lambda self: (self.bid + self.ask) / 2,
            })()

        underlying = ticker(100, 'STK', 749.9, 750.1)
        call = ticker(101, 'OPT', 4.0, 4.2, 0.2)
        put = ticker(102, 'OPT', 3.9, 4.1, 0.21)
        call_id = '__ivts__|SPY|20260717|750|C'
        put_id = '__ivts__|SPY|20260717|750|P'

        async def send_message_safe(_websocket, message):
            sent_messages.append(json.loads(message))

        env = {
            'connected_clients': {websocket},
            'client_subscriptions': {
                websocket: {
                    'underlying': underlying,
                    call_id: call,
                    put_id: put,
                },
            },
            'client_subscription_settings': {
                websocket: {
                    'greeks_enabled': False,
                    IV_TERM_STRUCTURE_SNAPSHOT_STATE_KEY: {
                        'stateId': 'state-1',
                        'symbol': 'SPY',
                        'subscriptionComplete': True,
                        'expectedOptionIds': [call_id, put_id],
                        'subscribedOptionIds': [call_id, put_id],
                    },
                },
            },
            'market_data_quote_as_of_by_ticker_key': {},
            'option_contract_timing_by_con_id': {
                101: {
                    'expiryAsOf': '2026-07-17T20:00:00.000Z',
                    'expiryTimingSource': 'ib_contract_details',
                    'lastTradeDate': '20260717',
                },
                102: {
                    'expiryAsOf': '2026-07-17T20:00:00.000Z',
                    'expiryTimingSource': 'ib_contract_details',
                    'lastTradeDate': '20260717',
                },
            },
            'send_message_safe': send_message_safe,
            'log_option_iv_debug_if_needed': lambda *_args: None,
            'get_api_market_data_generation': lambda: 43,
            'api_market_data_reset_in_progress': lambda: False,
        }
        handler = build_pending_tickers_handler(env)

        async def exercise_handler():
            handler([underlying, call, put])
            await asyncio.sleep(0)

        asyncio.run(exercise_handler())

        incremental = next(payload for payload in sent_messages if not payload.get('action'))
        snapshot = next(
            payload for payload in sent_messages
            if payload.get('action') == 'iv_term_structure_quote_snapshot'
        )
        self.assertEqual(incremental['marketDataGeneration'], 43)
        self.assertEqual(snapshot['marketDataGeneration'], 43)
        self.assertIs(incremental['coherent'], False)
        self.assertIs(snapshot['quoteComplete'], True)
        self.assertIs(snapshot['coherent'], True)
        self.assertEqual(snapshot['coherenceReason'], 'full_iv_term_structure_quote_snapshot')
        self.assertEqual(snapshot['batchId'], incremental['batchId'])
        self.assertEqual(snapshot['snapshotId'], snapshot['batchId'])
        self.assertEqual(snapshot['expectedOptionCount'], 2)
        self.assertEqual(snapshot['subscribedOptionCount'], 2)
        self.assertEqual(snapshot['snapshotOptionCount'], 2)
        self.assertEqual(set(snapshot['options']), {call_id, put_id})
        self.assertEqual(snapshot['underlyingQuote']['markSource'], 'market_price')
        self.assertNotIn('expiryAsOf', snapshot['underlyingQuote'])
        self.assertTrue(all(
            quote['expiryAsOf'] == '2026-07-17T20:00:00.000Z'
            for quote in snapshot['options'].values()
        ))
        for quote in [snapshot['underlyingQuote'], *snapshot['options'].values()]:
            self.assertEqual(quote['batchId'], snapshot['batchId'])
            self.assertEqual(quote['snapshotId'], snapshot['snapshotId'])
            self.assertEqual(quote['quoteAsOf'], snapshot['payloadAsOf'])
        self.assertTrue(all(
            quote['markSource'] == 'bid_ask_mid'
            for quote in snapshot['options'].values()
        ))
        initial_call_quote_as_of = snapshot['options'][call_id]['quoteAsOf']

        # Generic tick 106 / model-Greeks updates may refresh the display IV,
        # but cannot mint a new whole-curve price snapshot or relabel the BBO.
        sent_messages.clear()
        call.ticks = []
        call.modelGreeks.impliedVol = 0.23

        async def exercise_greeks_only_handler():
            handler([call])
            await asyncio.sleep(0)

        asyncio.run(exercise_greeks_only_handler())
        self.assertFalse(any(
            payload.get('action') == 'iv_term_structure_quote_snapshot'
            for payload in sent_messages
        ))
        greeks_incremental = next(payload for payload in sent_messages if not payload.get('action'))
        self.assertEqual(
            greeks_incremental['options'][call_id]['quoteAsOf'],
            initial_call_quote_as_of,
        )

        # A newly crossed BBO must emit explicit invalidation rather than
        # silently leaving the last coherent snapshot active in the browser.
        sent_messages.clear()
        call.ticks = [type('Tick', (), {'tickType': 1})()]
        put.ticks = [type('Tick', (), {'tickType': 2})()]
        put.ask = put.bid - 0.1

        async def exercise_invalid_handler():
            handler([put])
            await asyncio.sleep(0)

        asyncio.run(exercise_invalid_handler())
        invalid = next(
            payload for payload in sent_messages
            if payload.get('action') == 'iv_term_structure_quote_snapshot'
        )
        self.assertIs(invalid['coherent'], False)
        self.assertEqual(invalid['coherenceReason'], 'ivts_quote_set_incomplete')
        self.assertEqual(invalid['invalidQuoteOptionIds'], [put_id])

    def test_generic_greeks_event_does_not_refresh_unchanged_option_bbo(self):
        contract = type('Contract', (), {'conId': 901, 'secType': 'OPT'})()
        ticker = type('Ticker', (), {
            'contract': contract,
            'bid': 4.0,
            'ask': 4.2,
            'last': 4.1,
            'close': 4.1,
            'modelGreeks': type('Greeks', (), {'impliedVol': 0.2})(),
            'ticks': [],
            'marketPrice': lambda self: 4.1,
        })()
        env = {
            'market_data_quote_as_of_by_ticker_key': {},
            'market_data_quote_fingerprint_by_ticker_key': {},
        }
        first = '2026-07-19T08:00:00.000Z'
        greeks_only = '2026-07-19T08:01:00.000Z'

        # A cached BBO first seen through a Greeks-only event is not new BBO
        # evidence. A real bid tick establishes the initial receipt time.
        self.assertIs(record_ticker_quote_as_of(env, ticker, first), False)
        self.assertEqual(ticker_quote_as_of(env, ticker), '')
        ticker.ticks = [type('Tick', (), {'tickType': 1})()]
        self.assertIs(record_ticker_quote_as_of(env, ticker, first), True)
        ticker.ticks = []
        ticker.modelGreeks.impliedVol = 0.21
        self.assertIs(record_ticker_quote_as_of(env, ticker, greeks_only), False)
        self.assertEqual(ticker_quote_as_of(env, ticker), first)

        ticker.last = 4.15
        ticker.ticks = [type('Tick', (), {'tickType': 4})()]
        self.assertIs(record_ticker_quote_as_of(env, ticker, greeks_only), False)
        self.assertEqual(ticker_quote_as_of(env, ticker), first)

        ticker.bid = 4.05
        ticker.ticks = []
        self.assertIs(record_ticker_quote_as_of(env, ticker, greeks_only), True)
        self.assertEqual(ticker_quote_as_of(env, ticker), greeks_only)

        repeated_bbo = '2026-07-19T08:02:00.000Z'
        ticker.ticks = [type('Tick', (), {'tickType': 2})()]
        self.assertIs(record_ticker_quote_as_of(env, ticker, repeated_bbo), True)
        self.assertEqual(ticker_quote_as_of(env, ticker), repeated_bbo)

    def test_coherent_snapshot_preserves_each_leg_receipt_time_and_rejects_stale_cache(self):
        websocket = object()

        def ticker(con_id, sec_type, bid, ask):
            contract = type('Contract', (), {'conId': con_id, 'secType': sec_type})()
            return type('Ticker', (), {
                'contract': contract,
                'bid': bid,
                'ask': ask,
                'last': (bid + ask) / 2,
                'close': (bid + ask) / 2,
                'modelGreeks': None,
                'marketPrice': lambda self: (self.bid + self.ask) / 2,
            })()

        underlying = ticker(200, 'STK', 749.9, 750.1)
        call = ticker(201, 'OPT', 4.0, 4.2)
        put = ticker(202, 'OPT', 3.9, 4.1)
        call_id = '__ivts__|SPY|20260717|750|C'
        put_id = '__ivts__|SPY|20260717|750|P'
        fresh = '2026-07-19T08:00:00.000Z'
        stale = '2026-07-19T07:50:00.000Z'
        evidence = {
            ticker_quote_evidence_key(underlying): fresh,
            ticker_quote_evidence_key(call): fresh,
            ticker_quote_evidence_key(put): stale,
        }
        env = {
            'client_subscriptions': {
                websocket: {'underlying': underlying, call_id: call, put_id: put},
            },
            'client_subscription_settings': {
                websocket: {
                    'greeks_enabled': False,
                    IV_TERM_STRUCTURE_SNAPSHOT_STATE_KEY: {
                        'symbol': 'SPY',
                        'subscriptionComplete': True,
                        'expectedOptionIds': [call_id, put_id],
                        'subscribedOptionIds': [call_id, put_id],
                    },
                },
            },
            'market_data_quote_as_of_by_ticker_key': evidence,
            'iv_term_structure_max_quote_age_seconds': 120,
            'iv_term_structure_max_quote_skew_seconds': 120,
        }

        snapshot = build_iv_term_structure_quote_snapshot(
            env,
            websocket,
            payload_as_of=fresh,
            batch_id='batch-1',
        )

        self.assertIs(snapshot['coherent'], False)
        self.assertEqual(snapshot['coherenceReason'], 'ivts_quote_stale')
        self.assertEqual(snapshot['options'][put_id]['quoteAsOf'], stale)
        self.assertEqual(snapshot['options'][call_id]['quoteAsOf'], fresh)
        self.assertEqual(snapshot['staleQuoteOptionIds'], [put_id])

        env['iv_term_structure_max_quote_age_seconds'] = 1000
        snapshot = build_iv_term_structure_quote_snapshot(
            env,
            websocket,
            payload_as_of=fresh,
            batch_id='batch-skew',
        )
        self.assertIs(snapshot['coherent'], False)
        self.assertEqual(snapshot['coherenceReason'], 'ivts_quote_skew_exceeded')
        self.assertEqual(snapshot['quoteSkewSeconds'], 600.0)

    def test_coherent_snapshot_requires_all_expected_subscriptions_and_real_two_sided_marks(self):
        websocket = object()

        class Ticker:
            def __init__(self, con_id, sec_type, bid, ask, model_price=None):
                self.contract = type('Contract', (), {'conId': con_id, 'secType': sec_type})()
                self.bid = bid
                self.ask = ask
                self.last = float('nan')
                self.close = float('nan')
                self.modelGreeks = type('Greeks', (), {
                    'optPrice': model_price,
                    'impliedVol': 0.2,
                })() if model_price is not None else None

            def marketPrice(self):
                return (self.bid + self.ask) / 2

        underlying = Ticker(300, 'STK', 749.9, 750.1)
        call = Ticker(301, 'OPT', float('nan'), float('nan'), model_price=4.1)
        put = Ticker(302, 'OPT', 3.9, 4.1)
        call_id = '__ivts__|SPY|20260717|750|C'
        put_id = '__ivts__|SPY|20260717|750|P'
        now = '2026-07-19T08:00:00.000Z'
        env = {
            'client_subscriptions': {
                websocket: {'underlying': underlying, call_id: call, put_id: put},
            },
            'client_subscription_settings': {
                websocket: {
                    'greeks_enabled': False,
                    IV_TERM_STRUCTURE_SNAPSHOT_STATE_KEY: {
                        'symbol': 'SPY',
                        'subscriptionComplete': True,
                        'expectedOptionIds': [call_id, put_id],
                        'subscribedOptionIds': [call_id, put_id],
                    },
                },
            },
            'market_data_quote_as_of_by_ticker_key': {
                ticker_quote_evidence_key(underlying): now,
                ticker_quote_evidence_key(call): now,
                ticker_quote_evidence_key(put): now,
            },
        }

        snapshot = build_iv_term_structure_quote_snapshot(
            env, websocket, payload_as_of=now, batch_id='batch-2',
        )
        self.assertIs(snapshot['coherent'], False)
        self.assertEqual(snapshot['coherenceReason'], 'ivts_quote_set_incomplete')
        self.assertEqual(snapshot['invalidQuoteOptionIds'], [call_id])

        state = env['client_subscription_settings'][websocket][IV_TERM_STRUCTURE_SNAPSHOT_STATE_KEY]
        state['subscribedOptionIds'] = [put_id]
        snapshot = build_iv_term_structure_quote_snapshot(
            env, websocket, payload_as_of=now, batch_id='batch-3',
        )
        self.assertIs(snapshot['coherent'], False)
        self.assertEqual(snapshot['coherenceReason'], 'ivts_subscription_set_incomplete')
        self.assertEqual(snapshot['missingSubscriptionOptionIds'], [call_id])

    def test_fop_coherent_snapshot_requires_verified_underlying_month_binding(self):
        websocket = object()

        class Ticker:
            def __init__(self, con_id, sec_type, bid, ask, right='', strike=0, expiry=''):
                self.contract = type('Contract', (), {
                    'conId': con_id,
                    'secType': sec_type,
                    'symbol': 'ES',
                    'right': right,
                    'strike': strike,
                    'lastTradeDateOrContractMonth': expiry,
                })()
                self.bid = bid
                self.ask = ask
                self.last = (bid + ask) / 2
                self.close = self.last
                self.modelGreeks = None

            def marketPrice(self):
                return (self.bid + self.ask) / 2

        underlying = Ticker(70001, 'FUT', 5999.75, 6000.25)
        call = Ticker(70101, 'FOP', 19.0, 19.5, 'C', 6000.0, '20260724')
        put = Ticker(70102, 'FOP', 18.5, 19.0, 'P', 6000.0, '20260724')
        call_id = '__ivts__|ES|20260724|6000|C'
        put_id = '__ivts__|ES|20260724|6000|P'
        now = '2026-07-20T08:00:00.000Z'
        timing = {
            70101: {
                'underConId': 70001,
                'underlyingContractMonth': '202609',
                'underlyingBindingVerified': True,
            },
            70102: {
                'underConId': 70002,
                'underlyingContractMonth': '202612',
                'underlyingBindingVerified': True,
            },
        }
        env = {
            'client_subscriptions': {
                websocket: {
                    'underlying': underlying,
                    call_id: call,
                    put_id: put,
                },
            },
            'client_subscription_settings': {
                websocket: {
                    'greeks_enabled': False,
                    IV_TERM_STRUCTURE_SNAPSHOT_STATE_KEY: {
                        'symbol': 'ES',
                        'underlyingContractMonth': '202609',
                        'subscriptionComplete': True,
                        'expectedOptionIds': [call_id, put_id],
                        'subscribedOptionIds': [call_id, put_id],
                    },
                },
            },
            'market_data_quote_as_of_by_ticker_key': {
                ticker_quote_evidence_key(underlying): now,
                ticker_quote_evidence_key(call): now,
                ticker_quote_evidence_key(put): now,
            },
            'option_contract_timing_by_con_id': timing,
        }

        snapshot = build_iv_term_structure_quote_snapshot(
            env, websocket, payload_as_of=now, batch_id='fop-wrong-month',
        )
        self.assertIs(snapshot['coherent'], False)
        self.assertEqual(
            snapshot['coherenceReason'],
            'ivts_option_contract_identity_invalid',
        )
        self.assertEqual(snapshot['invalidContractIdentityOptionIds'], [put_id])
        self.assertNotIn(put_id, snapshot['options'])

        timing[70102] = {
            'underConId': 70001,
            'underlyingContractMonth': '202609',
            'underlyingBindingVerified': True,
        }
        snapshot = build_iv_term_structure_quote_snapshot(
            env, websocket, payload_as_of=now, batch_id='fop-correct-month',
        )
        self.assertIs(snapshot['coherent'], True)
        self.assertEqual(snapshot['invalidContractIdentityOptionIds'], [])
        self.assertEqual(set(snapshot['options']), {call_id, put_id})

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
            'get_api_market_data_generation': lambda: 46,
            'api_market_data_reset_in_progress': lambda: False,
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
        self.assertEqual(sent_messages[0]['marketDataGeneration'], 46)
        self.assert_server_time_evidence(
            sent_messages[0],
            'catalog_without_complete_option_quotes',
        )
        self.assertEqual(
            sent_messages[0]['underlyingQuote']['quoteAsOf'],
            sent_messages[0]['payloadAsOf'],
        )
        snapshot_state = settings[websocket][IV_TERM_STRUCTURE_SNAPSHOT_STATE_KEY]
        self.assertEqual(snapshot_state['symbol'], 'SI')
        self.assertEqual(snapshot_state['underlyingContractMonth'], '202608')
        self.assertIs(snapshot_state['subscriptionComplete'], False)

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
        self.assert_server_time_evidence(
            snapshot,
            'catalog_without_complete_option_quotes',
        )
        self.assertEqual(snapshot['underlyingQuote']['quoteAsOf'], snapshot['payloadAsOf'])
        self.assertEqual(snapshot['requestedUnderlyingContractMonth'], '202607')
        self.assertEqual(snapshot['underlyingContractMonth'], '202609')
        self.assertIn('using SI 202609 instead', snapshot['message'])
        self.assertEqual([call[3] for call in fake_ib.secdef_calls], [1007, 1008, 1009])
        self.assertEqual(captured_underlying_requests[-1]['contractMonth'], '202609')


if __name__ == '__main__':
    unittest.main()
