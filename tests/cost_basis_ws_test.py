"""Tests for cost_basis_ws.py — the shared ledger protocol layer.

Runs against temp-directory stores only. The Live-path parity test imports
ib_server_ws (which needs ib_async/websockets); it self-skips when those
bridge dependencies are absent so the rest of the suite stays stdlib-only.
"""

import asyncio
import configparser
import json
import pathlib
import sys
import tempfile
import unittest
import uuid

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import cost_basis_ws
from cost_basis_store import SCHEMA_USER_VERSION
from cost_basis_ws import (
    COST_BASIS_CLIENT_ACTIONS,
    SERVER_ACTIONS,
    create_store_env,
    handle_cost_basis_action,
    is_loopback_address,
)

LOOPBACK = ('127.0.0.1', 51000)
REMOTE = ('10.1.2.3', 51000)


class FakeWebSocket:
    def __init__(self, remote_address=LOOPBACK):
        self.remote_address = remote_address
        self.sent = []

    async def send(self, message):
        self.sent.append(message)


def _config(tmpdir, **overrides):
    values = {'db_path': str(pathlib.Path(tmpdir) / 'cost_basis.db')}
    values.update(overrides)
    lines = '\n'.join(f'{key} = {value}' for key, value in values.items())
    config = configparser.ConfigParser()
    config.read_string(f'[cost_basis]\n{lines}\n')
    return config


def _token(prefix='tok'):
    return f'{prefix}-{uuid.uuid4().hex[:16]}'


class CostBasisWsTestBase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.env = create_store_env(_config(self._tmp.name))
        self.ws = FakeWebSocket()

    async def call(self, action, ws=None, **fields):
        socket = ws or FakeWebSocket()
        handled = await handle_cost_basis_action(
            self.env, socket, {'action': action, 'requestId': 'req-1', **fields})
        self.assertTrue(handled)
        self.assertEqual(len(socket.sent), 1)
        return json.loads(socket.sent[0])

    async def make_book(self, symbol='TQQQ', account='U1111111'):
        response = await self.call(
            'create_cost_basis_book', account=account, symbol=symbol,
            startDate='2026-01-01')
        self.assertTrue(response['success'], response)
        return response['book']['bookId']

    @staticmethod
    def short_put(**overrides):
        event = {
            'kind': 'option_trade', 'tradeDate': '2026-06-01',
            'account': 'U1111111', 'right': 'P', 'strike': 45.0,
            'expiry': '20260717', 'contracts': -5, 'price': 1.20,
            'sharesPerContract': 100, 'fees': 3.25, 'cashAmount': 596.75,
        }
        event.update(overrides)
        return event


class RoutingTests(CostBasisWsTestBase):
    async def test_unknown_action_is_not_claimed(self):
        handled = await handle_cost_basis_action(
            self.env, self.ws, {'action': 'sync_underlying'})
        self.assertFalse(handled)
        self.assertEqual(self.ws.sent, [])

    async def test_every_client_action_has_a_server_action(self):
        self.assertEqual(set(SERVER_ACTIONS), set(COST_BASIS_CLIENT_ACTIONS))

    async def test_action_names_do_not_collide_with_persistence(self):
        import portfolio_store_ws
        import portfolio_admin_ws
        self.assertEqual(
            COST_BASIS_CLIENT_ACTIONS & portfolio_store_ws.PERSISTENCE_CLIENT_ACTIONS,
            frozenset())
        self.assertEqual(
            COST_BASIS_CLIENT_ACTIONS & portfolio_admin_ws.ADMIN_CLIENT_ACTIONS,
            frozenset())

    async def test_response_carries_the_request_id(self):
        response = await self.call('request_cost_basis_status')
        self.assertEqual(response['requestId'], 'req-1')


class LoopbackTests(CostBasisWsTestBase):
    async def test_remote_write_is_refused(self):
        remote = FakeWebSocket(REMOTE)
        response = await self.call('list_cost_basis_books', ws=remote)
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'remote_access_disabled')

    async def test_remote_status_leaks_no_detail(self):
        remote = FakeWebSocket(REMOTE)
        response = await self.call('request_cost_basis_status', ws=remote)
        self.assertTrue(response['success'])
        self.assertFalse(response['available'])
        self.assertNotIn('storeSchemaVersion', response)

    async def test_remote_request_never_opens_the_database(self):
        remote = FakeWebSocket(REMOTE)
        await self.call('list_cost_basis_books', ws=remote)
        self.assertIsNone(self.env['store'])

    async def test_loopback_variants_are_accepted(self):
        for host in ('127.0.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1%lo0'):
            with self.subTest(host=host):
                expected = host != 'fe80::1%lo0'
                self.assertEqual(is_loopback_address((host, 1)), expected)

    async def test_unparseable_address_fails_closed(self):
        for address in (None, (), ('not-an-ip', 1), ('', 1), 42):
            with self.subTest(address=address):
                self.assertFalse(is_loopback_address(address))


class StatusTests(CostBasisWsTestBase):
    async def test_status_reports_schema_and_kinds(self):
        response = await self.call('request_cost_basis_status')
        self.assertTrue(response['available'])
        self.assertEqual(response['storeSchemaVersion'], SCHEMA_USER_VERSION)
        self.assertIn('option_assignment', response['eventKinds'])
        self.assertFalse(response['features']['optionScenarioInputs'])

    async def test_disabled_ledger_reports_a_reason(self):
        env = create_store_env(_config(self._tmp.name, enabled='false'))
        socket = FakeWebSocket()
        await handle_cost_basis_action(
            env, socket, {'action': 'request_cost_basis_status'})
        response = json.loads(socket.sent[0])
        self.assertFalse(response['available'])
        self.assertEqual(response['reason'], 'disabled')

    async def test_disabled_ledger_refuses_writes(self):
        env = create_store_env(_config(self._tmp.name, enabled='false'))
        socket = FakeWebSocket()
        await handle_cost_basis_action(env, socket, {
            'action': 'create_cost_basis_book',
            'symbol': 'TQQQ', 'startDate': '2026-01-01',
        })
        response = json.loads(socket.sent[0])
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'disabled')


class ExecutionHistoryTests(CostBasisWsTestBase):
    async def test_historical_backend_reports_execution_api_unavailable(self):
        book_id = await self.make_book()
        response = await self.call(
            'request_cost_basis_executions', bookId=book_id,
            sinceTimestamp='2026-09-01T00:00:00')
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'broker_execution_history_unavailable')

    async def test_live_fetcher_is_scoped_from_the_book_not_browser_fields(self):
        book_id = await self.make_book()
        captured = []

        async def fetcher(request):
            captured.append(request)
            return {'executions': [{'execId': 'E1'}], 'coverage': 'tws_recent_window'}

        self.env['fetch_executions'] = fetcher
        response = await self.call(
            'request_cost_basis_executions', bookId=book_id,
            account='ATTACKER', symbol='SPY',
            sinceTimestamp='2026-09-01T09:30:00')
        self.assertTrue(response['success'], response)
        self.assertEqual(captured, [{
            'account': 'U1111111', 'symbol': 'TQQQ', 'secType': 'STK',
            'sinceTimestamp': '2026-09-01T09:30:00',
        }])
        self.assertEqual(response['executions'][0]['execId'], 'E1')


class MarketPriceTests(CostBasisWsTestBase):
    async def test_historical_backend_reports_fresh_price_unavailable(self):
        book_id = await self.make_book()
        response = await self.call(
            'request_cost_basis_market_price', bookId=book_id)
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'broker_market_price_unavailable')

    async def test_live_price_fetcher_is_scoped_from_the_book(self):
        book_id = await self.make_book()
        captured = []

        async def fetcher(request):
            captured.append(request)
            return {
                'marketPrice': 71.23,
                'fetchedAt': '2026-09-01T10:00:00+08:00',
                'coverage': 'tws_snapshot_quote',
            }

        self.env['fetch_market_price'] = fetcher
        response = await self.call(
            'request_cost_basis_market_price', bookId=book_id,
            account='ATTACKER', symbol='SPY')
        self.assertTrue(response['success'], response)
        self.assertEqual(captured, [{
            'account': 'U1111111', 'symbol': 'TQQQ', 'secType': 'STK',
            'currency': 'USD',
        }])
        self.assertEqual(response['marketPrice'], 71.23)


class OptionScenarioInputTests(CostBasisWsTestBase):
    async def test_historical_backend_reports_option_inputs_unavailable(self):
        book_id = await self.make_book()
        response = await self.call(
            'request_cost_basis_option_scenario_inputs',
            bookId=book_id, throughExpiry='20260902', contracts=[])
        self.assertFalse(response['success'])
        self.assertEqual(
            response['code'], 'broker_option_scenario_inputs_unavailable')

    async def test_live_fetcher_uses_book_scope_and_sanitized_contracts(self):
        book_id = await self.make_book()
        captured = []

        async def fetcher(request):
            captured.append(request)
            return {
                'underlyingPrice': 69.59,
                'options': [{'conId': 123, 'impliedVolatility': 0.62}],
                'ratesByExpiry': [{'expiry': '20270115', 'zeroRate': 0.031}],
            }

        self.env['fetch_option_scenario_inputs'] = fetcher
        status = await self.call('request_cost_basis_status')
        self.assertTrue(status['features']['optionScenarioInputs'])
        response = await self.call(
            'request_cost_basis_option_scenario_inputs',
            bookId=book_id, account='ATTACKER', symbol='SPY',
            throughExpiry='2026-09-02 ignored',
            contracts=[{
                'conId': 123, 'localSymbol': ' TQQQ  270115P00065000 ',
                'right': 'put', 'strike': 65, 'expiry': '2027-01-15',
                'ignored': 'not forwarded',
            }])
        self.assertTrue(response['success'], response)
        self.assertEqual(captured, [{
            'account': 'U1111111', 'symbol': 'TQQQ', 'secType': 'STK',
            'currency': 'USD',
            'throughExpiry': '20260902',
            'contracts': [{
                'conId': 123,
                'localSymbol': 'TQQQ  270115P00065000',
                'right': 'P', 'strike': 65, 'expiry': '20270115',
            }],
        }])
        self.assertEqual(response['underlyingPrice'], 69.59)

    async def test_live_fetcher_has_a_server_side_deadline(self):
        book_id = await self.make_book()

        async def fetcher(_request):
            await asyncio.sleep(1)

        self.env['fetch_option_scenario_inputs'] = fetcher
        original_timeout = cost_basis_ws.OPTION_SCENARIO_INPUT_TIMEOUT_SECONDS
        cost_basis_ws.OPTION_SCENARIO_INPUT_TIMEOUT_SECONDS = 0.01
        try:
            response = await self.call(
                'request_cost_basis_option_scenario_inputs',
                bookId=book_id, throughExpiry='20260902', contracts=[])
        finally:
            cost_basis_ws.OPTION_SCENARIO_INPUT_TIMEOUT_SECONDS = original_timeout
        self.assertFalse(response['success'])
        self.assertEqual(
            response['code'], 'broker_option_scenario_inputs_timeout')


class BookActionTests(CostBasisWsTestBase):
    async def test_create_and_list(self):
        book_id = await self.make_book()
        listed = await self.call('list_cost_basis_books')
        self.assertEqual([item['bookId'] for item in listed['books']], [book_id])

    async def test_duplicate_symbol_returns_a_typed_code(self):
        await self.make_book()
        response = await self.call(
            'create_cost_basis_book', account='U1111111', symbol='TQQQ',
            startDate='2026-02-01')
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'book_exists')

    async def test_same_symbol_in_another_account_creates_another_book(self):
        first = await self.make_book(account='U1111111')
        second = await self.make_book(account='U2222222')
        self.assertNotEqual(first, second)
        listed = await self.call('list_cost_basis_books')
        self.assertEqual(
            [(book['account'], book['symbol']) for book in listed['books']],
            [('U1111111', 'TQQQ'), ('U2222222', 'TQQQ')])

    async def test_same_root_can_have_distinct_stock_and_futures_books(self):
        await self.make_book(symbol='ES')
        response = await self.call(
            'create_cost_basis_book', account='U1111111', symbol='ES',
            startDate='2026-01-01',
            secType='FUT', defaultSharesPerContract=50)
        self.assertTrue(response['success'], response)
        self.assertEqual(response['book']['secType'], 'FUT')
        self.assertEqual(response['book']['defaultMultiplier'], 50)

    async def test_missing_field_is_an_invalid_request(self):
        response = await self.call('create_cost_basis_book', symbol='TQQQ')
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'invalid_request')

    async def test_cash_settled_symbol_is_refused(self):
        response = await self.call(
            'create_cost_basis_book', account='U1111111', symbol='SPX',
            startDate='2026-01-01',
            secType='IND')
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'invalid_request')

    async def test_archive_round_trip(self):
        book_id = await self.make_book()
        archived = await self.call('archive_cost_basis_book', bookId=book_id)
        self.assertTrue(archived['success'])
        self.assertTrue(archived['book']['archivedAtUtc'])
        listed = await self.call('list_cost_basis_books')
        self.assertEqual(listed['books'], [])


class EventActionTests(CostBasisWsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.book_id = await self.make_book()

    async def test_append_and_list(self):
        appended = await self.call(
            'append_cost_basis_event', bookId=self.book_id,
            event=self.short_put(), clientToken=_token())
        self.assertTrue(appended['success'], appended)
        self.assertEqual(appended['event']['seq'], 1)
        listed = await self.call('list_cost_basis_events', bookId=self.book_id)
        self.assertEqual(listed['total'], 1)

    async def test_client_token_replay_is_reported(self):
        token = _token()
        await self.call('append_cost_basis_event', bookId=self.book_id,
                        event=self.short_put(), clientToken=token)
        replay = await self.call('append_cost_basis_event', bookId=self.book_id,
                                 event=self.short_put(), clientToken=token)
        self.assertTrue(replay['idempotentReplay'])
        listed = await self.call('list_cost_basis_events', bookId=self.book_id)
        self.assertEqual(listed['total'], 1)

    async def test_overdrawn_assignment_returns_a_typed_code(self):
        response = await self.call(
            'append_cost_basis_event', bookId=self.book_id,
            clientToken=_token(),
            event={
                'kind': 'option_assignment', 'tradeDate': '2026-07-17',
                'account': 'U1111111', 'right': 'P', 'strike': 45.0,
                'expiry': '20260717', 'contracts': 5, 'shares': 500,
                'sharesPerContract': 100, 'cashAmount': -22500.0,
            })
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'position_overdraw')

    async def test_event_must_be_an_object(self):
        response = await self.call(
            'append_cost_basis_event', bookId=self.book_id,
            event='not-an-object', clientToken=_token())
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'invalid_request')

    async def test_event_for_another_account_is_refused(self):
        response = await self.call(
            'append_cost_basis_event', bookId=self.book_id,
            event=self.short_put(account='U2222222'), clientToken=_token())
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'invalid_request')

    async def test_unknown_book_returns_book_not_found(self):
        response = await self.call(
            'append_cost_basis_event', bookId='missing-book-id',
            event=self.short_put(), clientToken=_token())
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'book_not_found')

    async def test_void_round_trip(self):
        appended = await self.call(
            'append_cost_basis_event', bookId=self.book_id,
            event=self.short_put(), clientToken=_token())
        voided = await self.call(
            'void_cost_basis_event', bookId=self.book_id,
            eventId=appended['event']['eventId'], reason='keyed twice',
            clientToken=_token())
        self.assertTrue(voided['success'], voided)
        listed = await self.call('list_cost_basis_events', bookId=self.book_id)
        self.assertEqual(listed['total'], 0)

    async def test_import_batch(self):
        response = await self.call(
            'import_cost_basis_events', bookId=self.book_id,
            importBatchId=_token('batch'), clientTokenPrefix=_token('imp'),
            events=[
                {**self.short_put(), 'source': 'csv_import', 'externalRef': 'tr-1'},
                {**self.short_put(tradeDate='2026-06-02', strike=44.0),
                 'source': 'csv_import', 'externalRef': 'tr-2'},
            ])
        self.assertTrue(response['success'], response)
        self.assertEqual(response['inserted'], 2)

    async def test_import_forwards_atomic_tws_baseline_supersession(self):
        adopted = await self.call(
            'append_cost_basis_event', bookId=self.book_id,
            clientToken=_token(), event=self.short_put(
                tradeDate='2026-06-03', contracts=-1, price=1.23,
                cashAmount=123, fees=0, source='reconcile', tag='tws_snapshot',
                externalRef='tws-position-ws-1',
                note='Snapshot timestamp 2026-06-03T12:00:00.'))
        response = await self.call(
            'import_cost_basis_events', bookId=self.book_id,
            importBatchId=_token('batch'), clientTokenPrefix=_token('imp'),
            supersedeTwsEventIds=[adopted['event']['eventId']],
            events=[self.short_put(
                tradeDate='2026-06-03', contracts=-1, price=1.5,
                cashAmount=150, fees=0, source='csv_import',
                externalRef='stmt-real-ws-1',
                note='IBKR 2026-06-03, 10:00:00')])
        self.assertTrue(response['success'], response)
        self.assertEqual(response['supersededTwsBaselines'], 1)
        listed = await self.call('list_cost_basis_events', bookId=self.book_id)
        self.assertEqual(listed['total'], 1)
        self.assertEqual(listed['events'][0]['externalRef'], 'stmt-real-ws-1')

    async def test_import_rejects_a_non_list(self):
        response = await self.call(
            'import_cost_basis_events', bookId=self.book_id,
            importBatchId=_token('batch'), clientTokenPrefix=_token('imp'),
            events={'kind': 'option_trade'})
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'invalid_request')

    async def test_import_rejects_non_list_tws_supersession_ids(self):
        response = await self.call(
            'import_cost_basis_events', bookId=self.book_id,
            importBatchId=_token('batch'), clientTokenPrefix=_token('imp'),
            events=[self.short_put()], supersedeTwsEventIds='not-a-list')
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'invalid_request')

    async def test_import_rejects_an_oversized_batch(self):
        response = await self.call(
            'import_cost_basis_events', bookId=self.book_id,
            importBatchId=_token('batch'), clientTokenPrefix=_token('imp'),
            events=[self.short_put()] * (cost_basis_ws.MAX_IMPORT_EVENTS + 1))
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'invalid_request')

    async def test_snapshot_round_trip(self):
        await self.call('append_cost_basis_event', bookId=self.book_id,
                        event=self.short_put(), clientToken=_token())
        saved = await self.call(
            'save_cost_basis_snapshot', bookId=self.book_id,
            asOfDate='2026-06-30', summary={'sharesHeld': 0},
            twsSnapshot={'items': []}, reconciled=True)
        self.assertTrue(saved['success'], saved)
        listed = await self.call('list_cost_basis_snapshots', bookId=self.book_id)
        self.assertEqual(len(listed['snapshots']), 1)
        self.assertEqual(listed['snapshots'][0]['snapshotId'],
                         saved['snapshot']['snapshotId'])


class ResetActionTests(CostBasisWsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.book_id = await self.make_book()
        await self.call('append_cost_basis_event', bookId=self.book_id,
                        event=self.short_put(), clientToken=_token())

    async def test_plan_returns_the_phrase(self):
        plan = await self.call('request_cost_basis_reset_plan', bookId=self.book_id)
        self.assertTrue(plan['success'], plan)
        self.assertEqual(plan['phrase'], 'RESET U1111111 TQQQ 1 EVENTS')

    async def test_reset_requires_the_exact_phrase(self):
        response = await self.call(
            'reset_cost_basis_book', bookId=self.book_id,
            confirmation='RESET TQQQ 0 EVENTS', clientToken=_token())
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'reset_confirmation_mismatch')
        listed = await self.call('list_cost_basis_events', bookId=self.book_id)
        self.assertEqual(listed['total'], 1)

    async def test_reset_empties_the_book_and_archives_it(self):
        plan = await self.call('request_cost_basis_reset_plan', bookId=self.book_id)
        response = await self.call(
            'reset_cost_basis_book', bookId=self.book_id,
            confirmation=plan['phrase'], clientToken=_token(), reason='rebuild')
        self.assertTrue(response['success'], response)
        self.assertEqual(response['removedEvents'], 1)
        listed = await self.call('list_cost_basis_events', bookId=self.book_id)
        self.assertEqual(listed['total'], 0)
        resets = await self.call('list_cost_basis_resets', bookId=self.book_id)
        self.assertEqual(len(resets['resets']), 1)
        self.assertEqual(resets['resets'][0]['eventCount'], 1)

    async def test_reset_requires_a_confirmation_field(self):
        response = await self.call(
            'reset_cost_basis_book', bookId=self.book_id, clientToken=_token())
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'invalid_request')

    async def test_reset_is_refused_from_a_remote_socket(self):
        remote = FakeWebSocket(REMOTE)
        plan = await self.call('request_cost_basis_reset_plan', bookId=self.book_id)
        response = await self.call(
            'reset_cost_basis_book', ws=remote, bookId=self.book_id,
            confirmation=plan['phrase'], clientToken=_token())
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'remote_access_disabled')
        listed = await self.call('list_cost_basis_events', bookId=self.book_id)
        self.assertEqual(listed['total'], 1)


class DeleteBookActionTests(CostBasisWsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.book_id = await self.make_book()
        await self.call(
            'append_cost_basis_event', bookId=self.book_id,
            event=self.short_put(), clientToken=_token())

    async def test_plan_and_delete_remove_the_book(self):
        plan = await self.call(
            'request_cost_basis_delete_plan', bookId=self.book_id)
        self.assertTrue(plan['success'], plan)
        self.assertEqual(
            plan['phrase'],
            'DELETE U1111111 TQQQ 1 EVENTS 0 SNAPSHOTS 0 RESETS')
        deleted = await self.call(
            'delete_cost_basis_book', bookId=self.book_id,
            confirmation=plan['phrase'], clientToken=_token())
        self.assertTrue(deleted['success'], deleted)
        self.assertEqual(deleted['removedEvents'], 1)
        listed = await self.call('list_cost_basis_books')
        self.assertEqual(listed['books'], [])

    async def test_bad_confirmation_is_rejected_without_deleting(self):
        response = await self.call(
            'delete_cost_basis_book', bookId=self.book_id,
            confirmation='DELETE SOMETHING ELSE', clientToken=_token())
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'delete_confirmation_mismatch')
        listed = await self.call('list_cost_basis_events', bookId=self.book_id)
        self.assertEqual(listed['total'], 1)

    async def test_delete_is_refused_from_a_remote_socket(self):
        plan = await self.call(
            'request_cost_basis_delete_plan', bookId=self.book_id)
        response = await self.call(
            'delete_cost_basis_book', ws=FakeWebSocket(REMOTE),
            bookId=self.book_id, confirmation=plan['phrase'],
            clientToken=_token())
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'remote_access_disabled')
        listed = await self.call('list_cost_basis_events', bookId=self.book_id)
        self.assertEqual(listed['total'], 1)


class RebuildActionTests(CostBasisWsTestBase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.book_id = await self.make_book()
        await self.call('append_cost_basis_event', bookId=self.book_id,
                        event=self.short_put(), clientToken=_token())

    async def _phrase(self):
        plan = await self.call('request_cost_basis_reset_plan', bookId=self.book_id)
        return plan['phrase']

    async def test_rebuild_replaces_in_one_call(self):
        response = await self.call(
            'rebuild_cost_basis_book', bookId=self.book_id,
            confirmation=await self._phrase(), clientToken=_token(),
            importBatchId=_token('batch'),
            events=[self.short_put(tradeDate='2026-07-01', strike=43.0)])
        self.assertTrue(response['success'], response)
        self.assertEqual(response['removedEvents'], 1)
        self.assertEqual(response['inserted'], 1)

    async def test_a_failing_replacement_leaves_the_book_untouched(self):
        response = await self.call(
            'rebuild_cost_basis_book', bookId=self.book_id,
            confirmation=await self._phrase(), clientToken=_token(),
            importBatchId=_token('batch'),
            events=[{
                'kind': 'option_assignment', 'tradeDate': '2026-07-17',
                'account': 'U1111111', 'right': 'P', 'strike': 45.0,
                'expiry': '20260717', 'contracts': 5, 'shares': 500,
                'sharesPerContract': 100, 'cashAmount': -22500.0,
            }])
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'position_overdraw')
        listed = await self.call('list_cost_basis_events', bookId=self.book_id)
        self.assertEqual(listed['total'], 1)

    async def test_a_wrong_phrase_leaves_the_book_untouched(self):
        response = await self.call(
            'rebuild_cost_basis_book', bookId=self.book_id,
            confirmation='RESET TQQQ 99 EVENTS', clientToken=_token(),
            importBatchId=_token('batch'),
            events=[self.short_put(tradeDate='2026-07-01', strike=43.0)])
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'reset_confirmation_mismatch')
        listed = await self.call('list_cost_basis_events', bookId=self.book_id)
        self.assertEqual(listed['total'], 1)

    async def test_rebuild_is_refused_from_a_remote_socket(self):
        phrase = await self._phrase()
        response = await self.call(
            'rebuild_cost_basis_book', ws=FakeWebSocket(REMOTE), bookId=self.book_id,
            confirmation=phrase, clientToken=_token(),
            importBatchId=_token('batch'),
            events=[self.short_put(tradeDate='2026-07-01', strike=43.0)])
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'remote_access_disabled')
        listed = await self.call('list_cost_basis_events', bookId=self.book_id)
        self.assertEqual(listed['total'], 1)

    async def test_rebuild_rejects_a_non_list(self):
        response = await self.call(
            'rebuild_cost_basis_book', bookId=self.book_id,
            confirmation=await self._phrase(), clientToken=_token(),
            importBatchId=_token('batch'), events='nope')
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'invalid_request')


class ContainmentTests(CostBasisWsTestBase):
    async def test_a_store_crash_becomes_an_error_response(self):
        book_id = await self.make_book()

        def explode(*args, **kwargs):
            raise RuntimeError('boom')

        self.env['store'].list_events = explode
        response = await self.call('list_cost_basis_events', bookId=book_id)
        self.assertFalse(response['success'])
        self.assertEqual(response['code'], 'internal_store_error')
        self.assertEqual(response['message'], 'internal store error')

    async def test_errors_never_leak_the_database_path(self):
        response = await self.call('list_cost_basis_events', bookId='missing-book-id')
        self.assertFalse(response['success'])
        self.assertNotIn(self._tmp.name, json.dumps(response))
        self.assertNotIn('SELECT', json.dumps(response).upper())

    async def test_handler_never_raises_on_malformed_input(self):
        for data in ({'action': 'append_cost_basis_event'},
                     {'action': 'list_cost_basis_events', 'bookId': 5},
                     {'action': 'list_cost_basis_events', 'bookId': 'x', 'kinds': 'p'},
                     {'action': 'list_cost_basis_snapshots', 'bookId': 'x',
                      'limit': 'many'}):
            with self.subTest(data=data):
                socket = FakeWebSocket()
                handled = await handle_cost_basis_action(self.env, socket, data)
                self.assertTrue(handled)
                self.assertFalse(json.loads(socket.sent[0])['success'])


class BackendWiringTests(unittest.TestCase):
    """Both backends must route the ledger, and both must build its env.

    These read the source rather than import it: ib_server_ws needs
    ib_async/websockets, which a stdlib-only test run does not have, and a
    dispatch branch that silently disappeared is exactly the regression
    worth catching without those dependencies installed.
    """

    def test_live_backend_routes_ledger_actions(self):
        source = (REPO_ROOT / 'ib_server_ws.py').read_text(encoding='utf-8')
        self.assertIn('import cost_basis_ws', source)
        self.assertIn('cost_basis_ws.COST_BASIS_CLIENT_ACTIONS', source)
        self.assertIn("env.get('cost_basis_store_env')", source)

    def test_live_backend_builds_the_ledger_env(self):
        source = (REPO_ROOT / 'ib_server.py').read_text(encoding='utf-8')
        self.assertIn('cost_basis_ws.create_store_env(config)', source)
        self.assertIn("'cost_basis_store_env': cost_basis_store_env,", source)

    def test_historical_backend_serves_the_same_actions(self):
        source = (REPO_ROOT / 'historical_server.py').read_text(encoding='utf-8')
        self.assertIn('cost_basis_ws.handle_cost_basis_action', source)
        self.assertIn('cost_basis_ws.create_store_env(config)', source)

    def test_live_import_is_available_when_bridge_deps_are_installed(self):
        try:
            import ib_server_ws
        except Exception as exc:  # pragma: no cover - bridge deps absent
            self.skipTest(f'ib_server_ws unavailable: {exc}')
        self.assertTrue(hasattr(ib_server_ws, 'cost_basis_ws'))


if __name__ == '__main__':
    unittest.main()
