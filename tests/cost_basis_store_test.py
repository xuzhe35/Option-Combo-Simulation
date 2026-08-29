"""Tests for cost_basis_store.py — pure stdlib, temp directories only.

Covers the phase-1 acceptance list: schema creation and refusal to claim a
foreign file, book uniqueness and cash-settled rejection, per-kind field
validation, the single cash-derivation formula, assignment/exercise
direction and delivery-count rules, running-position validation including
the back-dating case that strands a later assignment, client-token
idempotency, external-ref import de-duplication, append-only voiding, and
snapshot hashing.
"""

import pathlib
import sqlite3
import sys
import tempfile
import unittest
import uuid
from datetime import datetime, timezone

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from cost_basis_store import (
    CostBasisStore,
    DELIVERY_CASH_TOLERANCE,
    DeleteConfirmationError,
    ResetConfirmationError,
    BookExistsError,
    BookNotFoundError,
    EventAlreadyVoidedError,
    EventNotFoundError,
    InvalidRequestError,
    PositionOverdrawError,
    SCHEMA_USER_VERSION,
    StoreUnavailableError,
    contract_key,
    future_key,
    derive_cash_amount,
    resolve_db_path,
)


def _token(prefix='tok'):
    return f'{prefix}-{uuid.uuid4().hex[:16]}'


class CostBasisStoreTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = pathlib.Path(self._tmp.name) / 'cost_basis.db'
        self.store = CostBasisStore(self.db_path).initialize()
        self.book = self.store.create_book(
            account='U1111111', symbol='TQQQ', start_date='2026-01-01')
        self.book_id = self.book['bookId']

    def append(self, event, *, token=None, allow_overdraw=False):
        return self.store.append_event(
            self.book_id, event,
            client_token=token or _token(),
            allow_overdraw=allow_overdraw,
        )

    def short_put(self, *, date='2026-06-01', strike=45.0, contracts=-5,
                  price=1.20, expiry='20260717', account='U1111111', fees=3.25):
        return {
            'kind': 'option_trade', 'tradeDate': date, 'account': account,
            'right': 'P', 'strike': strike, 'expiry': expiry,
            'contracts': contracts, 'price': price, 'sharesPerContract': 100,
            'fees': fees,
            'cashAmount': round(-(contracts * 100 * price) - fees, 6),
        }

    def put_assignment(self, *, date='2026-07-17', strike=45.0, contracts=5,
                       expiry='20260717', account='U1111111', fees=0.0):
        shares = contracts * 100
        return {
            'kind': 'option_assignment', 'tradeDate': date, 'account': account,
            'right': 'P', 'strike': strike, 'expiry': expiry,
            'contracts': contracts, 'shares': shares, 'sharesPerContract': 100,
            'fees': fees,
            'cashAmount': round(-(shares * strike) - fees, 6),
        }


class SchemaTests(CostBasisStoreTestBase):
    def test_initialize_sets_user_version_and_tables(self):
        conn = sqlite3.connect(self.db_path)
        try:
            self.assertEqual(
                conn.execute('PRAGMA user_version').fetchone()[0], SCHEMA_USER_VERSION)
            tables = {
                row[0] for row in
                conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
        finally:
            conn.close()
        self.assertLessEqual(
            {'cost_basis_books', 'cost_basis_events', 'cost_basis_snapshots'}, tables)

    def test_initialize_is_idempotent(self):
        CostBasisStore(self.db_path).initialize()
        self.assertEqual(len(self.store.list_books()), 1)

    def test_refuses_to_claim_a_foreign_database(self):
        foreign = pathlib.Path(self._tmp.name) / 'foreign.db'
        conn = sqlite3.connect(foreign)
        try:
            conn.execute('CREATE TABLE somebody_elses (id INTEGER)')
            conn.commit()
        finally:
            conn.close()
        with self.assertRaises(StoreUnavailableError):
            CostBasisStore(foreign).initialize()

    def test_operations_refuse_an_unmigrated_database(self):
        fresh = pathlib.Path(self._tmp.name) / 'fresh.db'
        with self.assertRaises(StoreUnavailableError):
            CostBasisStore(fresh).list_books()

    def test_resolve_db_path_prefers_explicit_env(self):
        path = resolve_db_path(
            env={'OPTION_COMBO_COST_BASIS_DB_PATH': '/tmp/explicit.db'})
        self.assertEqual(str(path), '/tmp/explicit.db')

    def test_resolve_db_path_defaults_outside_the_repository(self):
        path = resolve_db_path(env={'HOME': '/Users/example'}, platform='darwin')
        self.assertTrue(str(path).endswith('cost_basis.db'))
        self.assertNotIn('Option Combo Simulation', str(path))


class BookTests(CostBasisStoreTestBase):
    def test_create_book_normalizes_symbol(self):
        book = self.store.create_book(
            account='u1111111', symbol=' spy ', start_date='2026-02-01')
        self.assertEqual(book['account'], 'U1111111')
        self.assertEqual(book['symbol'], 'SPY')
        self.assertEqual(book['defaultSharesPerContract'], 100)

    def test_duplicate_active_symbol_is_rejected(self):
        with self.assertRaises(BookExistsError):
            self.store.create_book(
                account='u1111111', symbol='TQQQ', start_date='2026-03-01')

    def test_same_symbol_in_a_different_account_is_allowed(self):
        other = self.store.create_book(
            account='U2222222', symbol='TQQQ', start_date='2026-03-01')
        self.assertEqual(other['account'], 'U2222222')
        self.assertEqual(other['symbol'], 'TQQQ')

    def test_archived_symbol_frees_the_name(self):
        self.store.archive_book(self.book_id)
        again = self.store.create_book(
            account='U1111111', symbol='TQQQ', start_date='2026-03-01')
        self.assertNotEqual(again['bookId'], self.book_id)

    def test_cash_settled_underlying_is_rejected_at_creation(self):
        with self.assertRaises(InvalidRequestError) as ctx:
            self.store.create_book(
                account='U1111111', symbol='SPX', start_date='2026-01-01',
                sec_type='IND')
        self.assertIn('deliverable', str(ctx.exception))

    def test_unknown_book_id_raises(self):
        with self.assertRaises(BookNotFoundError):
            self.store.get_book('missing-book-id')

    def test_list_books_reports_event_counts_and_span(self):
        self.append(self.short_put(date='2026-06-01'))
        self.append(self.short_put(date='2026-06-20', strike=44.0))
        books = self.store.list_books()
        self.assertEqual(books[0]['eventCount'], 2)
        self.assertEqual(books[0]['firstEventDate'], '2026-06-01')
        self.assertEqual(books[0]['lastEventDate'], '2026-06-20')


class CashDerivationTests(unittest.TestCase):
    def test_one_formula_covers_both_option_directions(self):
        sold = derive_cash_amount({
            'kind': 'option_trade', 'contracts': -5, 'price': 1.20,
            'sharesPerContract': 100, 'fees': 3.25,
        })
        bought = derive_cash_amount({
            'kind': 'option_trade', 'contracts': 5, 'price': 1.20,
            'sharesPerContract': 100, 'fees': 3.25,
        })
        self.assertAlmostEqual(sold, 596.75)
        self.assertAlmostEqual(bought, -603.25)

    def test_assignment_cash_is_the_share_delivery_only(self):
        cash = derive_cash_amount({
            'kind': 'option_assignment', 'shares': 500, 'strike': 45.0, 'fees': 0.0,
        })
        self.assertAlmostEqual(cash, -22500.0)

    def test_expiry_costs_nothing_but_fees(self):
        self.assertAlmostEqual(
            derive_cash_amount({'kind': 'option_expiry', 'fees': 0.5}), -0.5)

    def test_contract_key_is_stable_against_float_noise(self):
        left = contract_key({
            'account': 'U1', 'right': 'P', 'strike': 45.0, 'expiry': '20260717'})
        right = contract_key({
            'account': 'U1', 'right': 'P', 'strike': 45.00000001, 'expiry': '20260717'})
        self.assertEqual(left, right)


class EventValidationTests(CostBasisStoreTestBase):
    def test_option_trade_requires_contract_identity(self):
        with self.assertRaises(InvalidRequestError):
            self.append({
                'kind': 'option_trade', 'tradeDate': '2026-06-01',
                'contracts': -5, 'price': 1.2, 'cashAmount': 600,
            })

    def test_trade_date_must_be_a_real_date(self):
        with self.assertRaises(InvalidRequestError):
            self.append(self.short_put(date='2026-02-30'))

    def test_expiry_must_be_a_real_date(self):
        with self.assertRaises(InvalidRequestError):
            self.append(self.short_put(expiry='20260732'))

    def test_non_finite_numbers_are_rejected(self):
        with self.assertRaises(InvalidRequestError):
            self.append(self.short_put(price=float('inf')))

    def test_assignment_must_close_a_short(self):
        event = self.put_assignment()
        event['contracts'] = -5
        event['shares'] = 500
        with self.assertRaises(InvalidRequestError) as ctx:
            self.append(event)
        self.assertIn('short position', str(ctx.exception))

    def test_short_call_assignment_must_deliver_shares_away(self):
        self.append({
            'kind': 'option_trade', 'tradeDate': '2026-06-01', 'account': 'U1111111',
            'right': 'C', 'strike': 60.0, 'expiry': '20260717', 'contracts': -3,
            'price': 0.9, 'sharesPerContract': 100, 'fees': 0,
            'cashAmount': 270.0,
        })
        bad = {
            'kind': 'option_assignment', 'tradeDate': '2026-07-17',
            'account': 'U1111111', 'right': 'C', 'strike': 60.0,
            'expiry': '20260717', 'contracts': 3, 'shares': 300,
            'sharesPerContract': 100, 'fees': 0, 'cashAmount': -18000.0,
        }
        with self.assertRaises(InvalidRequestError) as ctx:
            self.append(bad)
        self.assertIn('negative share delivery', str(ctx.exception))

    def test_delivery_count_must_match_contracts_times_multiplier(self):
        event = self.put_assignment()
        event['shares'] = 400  # five contracts must deliver 500
        event['cashAmount'] = -18000.0
        with self.assertRaises(InvalidRequestError) as ctx:
            self.append(event)
        self.assertIn('does not match', str(ctx.exception))

    def test_adjusted_multiplier_is_honoured(self):
        self.append({
            'kind': 'option_trade', 'tradeDate': '2026-06-01', 'account': 'U1111111',
            'right': 'P', 'strike': 45.0, 'expiry': '20260717', 'contracts': -1,
            'price': 1.0, 'sharesPerContract': 130, 'fees': 0, 'cashAmount': 130.0,
        })
        result = self.append({
            'kind': 'option_assignment', 'tradeDate': '2026-07-17',
            'account': 'U1111111', 'right': 'P', 'strike': 45.0,
            'expiry': '20260717', 'contracts': 1, 'shares': 130,
            'sharesPerContract': 130, 'fees': 0, 'cashAmount': -5850.0,
        })
        self.assertEqual(result['event']['shares'], 130)

    def test_expiry_must_not_move_shares(self):
        self.append(self.short_put())
        with self.assertRaises(InvalidRequestError) as ctx:
            self.append({
                'kind': 'option_expiry', 'tradeDate': '2026-07-17',
                'account': 'U1111111', 'right': 'P', 'strike': 45.0,
                'expiry': '20260717', 'contracts': 5, 'shares': 500,
                'cashAmount': 0.0,
            })
        self.assertIn('must not move shares', str(ctx.exception))

    def test_dividend_must_be_positive_and_fee_negative(self):
        with self.assertRaises(InvalidRequestError):
            self.append({'kind': 'dividend', 'tradeDate': '2026-06-30',
                         'account': 'U1111111', 'cashAmount': -10.0})
        with self.assertRaises(InvalidRequestError):
            self.append({'kind': 'fee', 'tradeDate': '2026-06-30',
                         'account': 'U1111111', 'cashAmount': 10.0})

    def test_manual_adjust_requires_a_note(self):
        with self.assertRaises(InvalidRequestError):
            self.append({'kind': 'manual_adjust', 'tradeDate': '2026-06-30',
                         'account': 'U1111111', 'cashAmount': 100.0})

    def test_manual_adjust_rejects_silently_ignored_position_fields(self):
        with self.assertRaises(InvalidRequestError) as ctx:
            self.append({
                'kind': 'manual_adjust', 'tradeDate': '2026-06-30',
                'account': 'U1111111', 'shares': 100, 'price': 50,
                'cashAmount': -5000, 'note': 'position correction',
            })
        self.assertIn('cash-only', str(ctx.exception))

    def test_broker_timestamp_is_strict_and_matches_trade_date(self):
        with self.assertRaises(InvalidRequestError):
            self.append({**self.short_put(),
                         'brokerTimestamp': '2026-06-01 10:00:00'})
        with self.assertRaises(InvalidRequestError):
            self.append({**self.short_put(),
                         'brokerTimestamp': '2026-06-02T10:00:00'})

    def test_split_must_not_carry_cash(self):
        with self.assertRaises(InvalidRequestError):
            self.append({'kind': 'split', 'tradeDate': '2026-06-30',
                         'account': 'U1111111', 'splitRatio': 2, 'cashAmount': 5.0})

    def test_overridden_cash_is_flagged_not_rejected(self):
        event = self.short_put()
        event['cashAmount'] = event['cashAmount'] - 0.75
        result = self.append(event)
        self.assertTrue(result['event']['derivedMismatch'])

    def test_matching_cash_is_not_flagged(self):
        result = self.append(self.short_put())
        self.assertFalse(result['event']['derivedMismatch'])


class RunningPositionTests(CostBasisStoreTestBase):
    def test_broker_time_not_insert_sequence_controls_same_day_validation(self):
        self.append({**self.short_put(contracts=-1),
                     'brokerTimestamp': '2026-06-01T10:00:00'})
        # Inserted later, but economically earlier. Replaying by seq would
        # accept this close; replaying by broker time correctly rejects it.
        with self.assertRaises(PositionOverdrawError):
            self.append({
                'kind': 'option_trade', 'tradeDate': '2026-06-01',
                'brokerTimestamp': '2026-06-01T09:00:00',
                'account': 'U1111111', 'right': 'P', 'strike': 45,
                'expiry': '20260717', 'contracts': 1, 'price': 0.4,
                'sharesPerContract': 100, 'fees': 0, 'cashAmount': -40,
                'source': 'csv_import', 'tag': 'ibkr_close',
            })
    def test_ibkr_close_without_opening_is_rejected_not_reversed(self):
        close = {
            'kind': 'option_trade', 'tradeDate': '2026-08-19',
            'account': 'U1111111', 'right': 'C', 'strike': 95,
            'expiry': '20261231', 'contracts': -3, 'price': 1.15,
            'sharesPerContract': 100, 'fees': 0, 'cashAmount': 345,
            'source': 'csv_import', 'tag': 'ibkr_close',
        }
        with self.assertRaises(PositionOverdrawError):
            self.append(close)
        with self.assertRaises(PositionOverdrawError):
            self.append(close, allow_overdraw=True)
        self.assertEqual(self.store.list_events(self.book_id)['total'], 0)

    def test_ibkr_close_is_accepted_against_the_exact_open_lot(self):
        self.append({
            'kind': 'option_trade', 'tradeDate': '2026-08-02',
            'account': 'U1111111', 'right': 'C', 'strike': 95,
            'expiry': '20261231', 'contracts': 3, 'price': 7,
            'sharesPerContract': 100, 'fees': 0, 'cashAmount': -2100,
            'source': 'csv_import', 'tag': 'prior_basis',
        })
        self.append({
            'kind': 'option_trade', 'tradeDate': '2026-08-19',
            'account': 'U1111111', 'right': 'C', 'strike': 95,
            'expiry': '20261231', 'contracts': -3, 'price': 1.15,
            'sharesPerContract': 100, 'fees': 0, 'cashAmount': 345,
            'source': 'csv_import', 'tag': 'ibkr_close',
        })
        self.assertEqual(self.store.list_events(self.book_id)['total'], 2)

    def test_ibkr_open_cannot_silently_close_an_existing_position(self):
        self.append(self.short_put(contracts=-1))
        with self.assertRaises(PositionOverdrawError):
            self.append({
                **self.short_put(date='2026-06-02', contracts=1, price=0.4, fees=0),
                'source': 'csv_import', 'tag': 'ibkr_open',
            })

    def test_assignment_without_an_open_short_is_rejected(self):
        with self.assertRaises(PositionOverdrawError):
            self.append(self.put_assignment())

    def test_assignment_larger_than_the_open_short_is_rejected(self):
        self.append(self.short_put(contracts=-2))
        with self.assertRaises(PositionOverdrawError):
            self.append(self.put_assignment(contracts=5))

    def test_full_wheel_cycle_is_accepted(self):
        self.append(self.short_put())
        self.append(self.put_assignment())
        events = self.store.list_events(self.book_id)['events']
        self.assertEqual([item['kind'] for item in events],
                         ['option_trade', 'option_assignment'])

    def test_a_rejected_assignment_leaves_no_row_behind(self):
        with self.assertRaises(PositionOverdrawError):
            self.append(self.put_assignment())
        self.assertEqual(self.store.list_events(self.book_id)['total'], 0)

    def test_backdated_close_that_strands_a_later_assignment_is_rejected(self):
        self.append(self.short_put(date='2026-06-01', contracts=-5))
        self.append(self.put_assignment(date='2026-07-17', contracts=5))
        # Buying the short back on 2026-06-20 means nothing was open to be
        # assigned in July; the ledger must refuse rather than silently
        # leaving a stranded assignment behind.
        with self.assertRaises(PositionOverdrawError):
            self.append({
                'kind': 'option_trade', 'tradeDate': '2026-06-20',
                'account': 'U1111111', 'right': 'P', 'strike': 45.0,
                'expiry': '20260717', 'contracts': 5, 'price': 0.4,
                'sharesPerContract': 100, 'fees': 0, 'cashAmount': -200.0,
            })
        self.assertEqual(self.store.list_events(self.book_id)['total'], 2)

    def test_allow_overdraw_downgrades_the_failure_to_a_warning(self):
        result = self.append(self.put_assignment(), allow_overdraw=True)
        self.assertTrue(any(w.startswith('overdraw:') for w in result['warnings']))

    def test_event_account_must_match_book_account(self):
        self.append(self.short_put(account='U1111111'))
        with self.assertRaises(InvalidRequestError):
            self.append(self.put_assignment(account='U2222222'))

    def test_missing_event_account_inherits_book_account(self):
        event = self.short_put()
        event.pop('account')
        stored = self.append(event)['event']
        self.assertEqual(stored['account'], 'U1111111')

    def test_going_net_short_shares_warns(self):
        self.append({
            'kind': 'option_trade', 'tradeDate': '2026-06-01', 'account': 'U1111111',
            'right': 'C', 'strike': 60.0, 'expiry': '20260717', 'contracts': -3,
            'price': 0.9, 'sharesPerContract': 100, 'fees': 0, 'cashAmount': 270.0,
        })
        result = self.append({
            'kind': 'option_assignment', 'tradeDate': '2026-07-17',
            'account': 'U1111111', 'right': 'C', 'strike': 60.0,
            'expiry': '20260717', 'contracts': 3, 'shares': -300,
            'sharesPerContract': 100, 'fees': 0, 'cashAmount': 18000.0,
        })
        self.assertIn('net_short_shares', result['warnings'])

    def test_covered_call_assignment_does_not_warn(self):
        self.append({
            'kind': 'opening_balance', 'tradeDate': '2026-01-01',
            'account': 'U1111111', 'shares': 500, 'price': 40.0,
            'cashAmount': -20000.0,
        })
        self.append({
            'kind': 'option_trade', 'tradeDate': '2026-06-01', 'account': 'U1111111',
            'right': 'C', 'strike': 60.0, 'expiry': '20260717', 'contracts': -3,
            'price': 0.9, 'sharesPerContract': 100, 'fees': 0, 'cashAmount': 270.0,
        })
        result = self.append({
            'kind': 'option_assignment', 'tradeDate': '2026-07-17',
            'account': 'U1111111', 'right': 'C', 'strike': 60.0,
            'expiry': '20260717', 'contracts': 3, 'shares': -300,
            'sharesPerContract': 100, 'fees': 0, 'cashAmount': 18000.0,
        })
        self.assertEqual(result['warnings'], [])


class IdempotencyTests(CostBasisStoreTestBase):
    def test_replaying_a_client_token_does_not_double_record(self):
        token = _token()
        first = self.append(self.short_put(), token=token)
        second = self.append(self.short_put(), token=token)
        self.assertFalse(first['idempotentReplay'])
        self.assertTrue(second['idempotentReplay'])
        self.assertEqual(first['event']['eventId'], second['event']['eventId'])
        self.assertEqual(self.store.list_events(self.book_id)['total'], 1)

    def test_seq_is_dense_and_monotonic(self):
        for index in range(3):
            self.append(self.short_put(date=f'2026-06-0{index + 1}'))
        events = self.store.list_events(self.book_id)['events']
        self.assertEqual([item['seq'] for item in events], [1, 2, 3])


class ImportTests(CostBasisStoreTestBase):
    def _rows(self):
        return [
            {**self.short_put(date='2026-06-01'), 'source': 'csv_import',
             'externalRef': 'trade-1001'},
            {**self.short_put(date='2026-06-02', strike=44.0), 'source': 'csv_import',
             'externalRef': 'trade-1002'},
        ]

    def test_import_inserts_a_batch(self):
        result = self.store.import_events(
            self.book_id, self._rows(),
            import_batch_id=_token('batch'), client_token_prefix=_token('imp'))
        self.assertEqual(result['inserted'], 2)
        self.assertEqual(result['skipped'], 0)

    def test_import_short_warning_uses_the_final_batch_balance(self):
        timestamp = '2026-08-28T16:20:00'
        rows = [
            {
                'kind': 'share_trade', 'tradeDate': '2026-08-28',
                'brokerTimestamp': timestamp, 'account': 'U1111111',
                'shares': -100, 'price': 70, 'cashAmount': 7000,
                'fees': 0, 'source': 'csv_import', 'externalRef': 'shares-1',
            },
            {
                'kind': 'share_trade', 'tradeDate': '2026-08-28',
                'brokerTimestamp': timestamp, 'account': 'U1111111',
                'shares': 300, 'price': 72, 'cashAmount': -21600,
                'fees': 0, 'source': 'csv_import', 'externalRef': 'shares-2',
            },
        ]
        result = self.store.import_events(
            self.book_id, rows,
            import_batch_id=_token('batch'), client_token_prefix=_token('imp'))
        self.assertNotIn('net_short_shares', result['warnings'])

    def test_import_reports_a_supported_final_short_position(self):
        result = self.store.import_events(
            self.book_id, [{
                'kind': 'share_trade', 'tradeDate': '2026-08-28',
                'account': 'U1111111', 'shares': -100, 'price': 70,
                'cashAmount': 7000, 'fees': 0, 'source': 'csv_import',
                'externalRef': 'short-shares',
            }], import_batch_id=_token('batch'),
            client_token_prefix=_token('imp'))
        self.assertIn('net_short_shares', result['warnings'])

    def test_overlapping_statement_skips_already_imported_rows(self):
        self.store.import_events(
            self.book_id, self._rows(),
            import_batch_id=_token('batch'), client_token_prefix=_token('imp'))
        overlapping = self._rows() + [
            {**self.short_put(date='2026-06-03', strike=43.0), 'source': 'csv_import',
             'externalRef': 'trade-1003'},
        ]
        result = self.store.import_events(
            self.book_id, overlapping,
            import_batch_id=_token('batch2'), client_token_prefix=_token('imp2'))
        self.assertEqual(result['inserted'], 1)
        self.assertEqual(result['skipped'], 2)
        self.assertEqual(self.store.list_events(self.book_id)['total'], 3)

    def test_replaying_a_batch_id_is_a_no_op(self):
        batch = _token('batch')
        self.store.import_events(
            self.book_id, self._rows(),
            import_batch_id=batch, client_token_prefix=_token('imp'))
        replay = self.store.import_events(
            self.book_id, self._rows(),
            import_batch_id=batch, client_token_prefix=_token('imp2'))
        self.assertTrue(replay['idempotentReplay'])
        self.assertEqual(replay['inserted'], 0)

    def test_a_bad_row_rolls_back_the_whole_batch(self):
        rows = self._rows()
        rows.append({**self.put_assignment(date='2026-06-05', contracts=99),
                     'source': 'csv_import', 'externalRef': 'trade-1004'})
        with self.assertRaises(PositionOverdrawError):
            self.store.import_events(
                self.book_id, rows,
                import_batch_id=_token('batch'), client_token_prefix=_token('imp'))
        self.assertEqual(self.store.list_events(self.book_id)['total'], 0)

    def test_same_external_ref_in_a_different_account_book_is_kept(self):
        other = self.store.create_book(
            account='U2222222', symbol='TQQQ', start_date='2026-01-01')
        first = self.store.import_events(
            self.book_id,
            [{**self.short_put(account='U1111111'), 'source': 'csv_import',
              'externalRef': 'trade-1001'}],
            import_batch_id=_token('batch'), client_token_prefix=_token('imp'))
        second = self.store.import_events(
            other['bookId'],
            [{**self.short_put(account='U2222222'), 'source': 'csv_import',
              'externalRef': 'trade-1001'}],
            import_batch_id=_token('batch'), client_token_prefix=_token('imp'))
        self.assertEqual(first['inserted'], 1)
        self.assertEqual(second['inserted'], 1)

    def test_complete_csv_history_atomically_supersedes_an_option_tws_baseline(self):
        adopted = self.append({
            **self.short_put(date='2026-06-03', contracts=-1, price=1.23, fees=0),
            'source': 'reconcile', 'tag': 'tws_snapshot',
            'externalRef': 'tws-position-option-1',
            'note': 'Snapshot timestamp 2026-06-03T12:00:00.',
        })['event']
        actual = {
            **self.short_put(date='2026-06-03', contracts=-1, price=1.5, fees=0),
            'source': 'csv_import', 'externalRef': 'stmt-real-option-1',
            'note': 'IBKR 2026-06-03, 10:00:00',
        }
        batch = _token('batch')
        result = self.store.import_events(
            self.book_id, [actual], import_batch_id=batch,
            client_token_prefix=_token('imp'),
            supersede_tws_event_ids=[adopted['eventId']])
        self.assertEqual(result['inserted'], 1)
        self.assertEqual(result['supersededTwsBaselines'], 1)
        live = self.store.list_events(self.book_id)['events']
        self.assertEqual(len(live), 1)
        self.assertEqual(live[0]['externalRef'], 'stmt-real-option-1')
        self.assertEqual(live[0]['cashAmount'], 150)
        audit = self.store.list_events(self.book_id, include_voided=True)['events']
        old = next(item for item in audit if item['eventId'] == adopted['eventId'])
        self.assertIsNotNone(old['voidedAtUtc'])
        self.assertIn('complete broker CSV', old['voidReason'])
        replay = self.store.import_events(
            self.book_id, [actual], import_batch_id=batch,
            client_token_prefix=_token('different-imp'),
            supersede_tws_event_ids=[adopted['eventId']])
        self.assertTrue(replay['idempotentReplay'])
        self.assertEqual(replay['supersededTwsBaselines'], 1)

    def test_post_snapshot_increment_cannot_erase_the_tws_baseline(self):
        adopted = self.append({
            **self.short_put(date='2026-06-03', contracts=-1, price=1.23, fees=0),
            'source': 'reconcile', 'tag': 'tws_snapshot',
            'externalRef': 'tws-position-option-2',
            'note': 'Snapshot timestamp 2026-06-03T12:00:00.',
        })['event']
        later = {
            **self.short_put(date='2026-06-03', contracts=-1, price=1.5, fees=0),
            'source': 'csv_import', 'externalRef': 'stmt-later-option',
            'note': 'IBKR 2026-06-03, 13:00:00',
        }
        with self.assertRaises(InvalidRequestError):
            self.store.import_events(
                self.book_id, [later], import_batch_id=_token('batch'),
                client_token_prefix=_token('imp'),
                supersede_tws_event_ids=[adopted['eventId']])
        live = self.store.list_events(self.book_id)['events']
        self.assertEqual(len(live), 1)
        self.assertEqual(live[0]['eventId'], adopted['eventId'])
        self.assertIsNone(live[0]['voidedAtUtc'])

    def test_post_snapshot_increment_appends_when_it_does_not_request_supersession(self):
        adopted = self.append({
            **self.short_put(date='2026-06-03', contracts=-1, price=1.23, fees=0),
            'source': 'reconcile', 'tag': 'tws_snapshot',
            'externalRef': 'tws-position-option-increment',
            'note': 'Snapshot timestamp 2026-06-03T12:00:00.',
        })['event']
        later = {
            **self.short_put(date='2026-06-03', contracts=-1, price=1.5, fees=0),
            'source': 'csv_import', 'externalRef': 'stmt-later-increment',
            'note': 'IBKR 2026-06-03, 13:00:00',
        }
        result = self.store.import_events(
            self.book_id, [later], import_batch_id=_token('batch'),
            client_token_prefix=_token('imp'))
        self.assertEqual(result['inserted'], 1)
        self.assertEqual(result['supersededTwsBaselines'], 0)
        live = self.store.list_events(self.book_id)['events']
        self.assertEqual(len(live), 2)
        self.assertEqual(sum(item['contracts'] for item in live), -2)
        self.assertIsNone(next(
            item for item in live if item['eventId'] == adopted['eventId'])['voidedAtUtc'])

    def test_legacy_tws_baseline_uses_created_at_for_same_day_supersession(self):
        local_noon_utc = datetime(2026, 6, 3, 12, 0, 0).astimezone(timezone.utc)
        self.store._now = lambda: local_noon_utc
        adopted = self.append({
            **self.short_put(date='2026-06-03', contracts=-1, price=1.23, fees=0),
            'source': 'reconcile', 'tag': 'tws_snapshot',
            'externalRef': 'legacy-tws-option',
            'note': 'Adopted from an authoritative TWS position snapshot.',
        })['event']
        actual = {
            **self.short_put(date='2026-06-03', contracts=-1, price=1.5, fees=0),
            'source': 'csv_import', 'externalRef': 'legacy-real-option',
            'note': 'IBKR 2026-06-03, 10:00:00',
        }
        result = self.store.import_events(
            self.book_id, [actual], import_batch_id=_token('batch'),
            client_token_prefix=_token('imp'),
            supersede_tws_event_ids=[adopted['eventId']])
        self.assertEqual(result['supersededTwsBaselines'], 1)
        live = self.store.list_events(self.book_id)['events']
        self.assertEqual(len(live), 1)
        self.assertEqual(live[0]['externalRef'], 'legacy-real-option')

    def test_post_created_legacy_tws_increment_is_not_mistaken_for_history(self):
        local_noon_utc = datetime(2026, 6, 3, 12, 0, 0).astimezone(timezone.utc)
        self.store._now = lambda: local_noon_utc
        adopted = self.append({
            **self.short_put(date='2026-06-03', contracts=-1, price=1.23, fees=0),
            'source': 'reconcile', 'tag': 'tws_snapshot',
            'externalRef': 'legacy-tws-increment',
            'note': 'Adopted from an authoritative TWS position snapshot.',
        })['event']
        later = {
            **self.short_put(date='2026-06-03', contracts=-1, price=1.5, fees=0),
            'source': 'csv_import', 'externalRef': 'legacy-later-option',
            'note': 'IBKR 2026-06-03, 13:00:00',
        }
        result = self.store.import_events(
            self.book_id, [later], import_batch_id=_token('batch'),
            client_token_prefix=_token('imp'))
        self.assertEqual(result['inserted'], 1)
        self.assertEqual(result['supersededTwsBaselines'], 0)
        live = self.store.list_events(self.book_id)['events']
        self.assertEqual(len(live), 2)
        self.assertIsNone(next(
            item for item in live if item['eventId'] == adopted['eventId'])['voidedAtUtc'])

    def test_failed_replacement_quantity_check_rolls_back_both_sides(self):
        adopted = self.append({
            **self.short_put(date='2026-06-03', contracts=-1, price=1.23, fees=0),
            'source': 'reconcile', 'tag': 'tws_snapshot',
            'externalRef': 'tws-position-option-3',
            'note': 'Snapshot timestamp 2026-06-03T12:00:00.',
        })['event']
        wrong_quantity = {
            **self.short_put(date='2026-06-03', contracts=-2, price=1.5, fees=0),
            'source': 'csv_import', 'externalRef': 'stmt-wrong-option',
            'note': 'IBKR 2026-06-03, 10:00:00',
        }
        with self.assertRaises(InvalidRequestError):
            self.store.import_events(
                self.book_id, [wrong_quantity], import_batch_id=_token('batch'),
                client_token_prefix=_token('imp'),
                supersede_tws_event_ids=[adopted['eventId']])
        all_rows = self.store.list_events(self.book_id, include_voided=True)['events']
        self.assertEqual(len(all_rows), 1)
        self.assertIsNone(all_rows[0]['voidedAtUtc'])

    def test_partial_pre_snapshot_overlap_is_rejected_without_a_supersession(self):
        adopted = self.append({
            **self.short_put(date='2026-06-03', contracts=-1, price=1.23, fees=0),
            'source': 'reconcile', 'tag': 'tws_snapshot',
            'externalRef': 'tws-position-option-4',
            'note': 'Snapshot timestamp 2026-06-03T12:00:00.',
        })['event']
        partial = {
            **self.short_put(date='2026-06-03', contracts=-0.5, price=1.5, fees=0),
            'source': 'csv_import', 'externalRef': 'stmt-partial-option',
            'note': 'IBKR 2026-06-03, 10:00:00',
        }
        with self.assertRaises(InvalidRequestError) as ctx:
            self.store.import_events(
                self.book_id, [partial], import_batch_id=_token('batch'),
                client_token_prefix=_token('imp'))
        self.assertIn('overlaps an adopted TWS baseline', str(ctx.exception))
        live = self.store.list_events(self.book_id)['events']
        self.assertEqual(len(live), 1)
        self.assertEqual(live[0]['eventId'], adopted['eventId'])

    def test_complete_csv_share_history_supersedes_a_share_tws_baseline(self):
        adopted = self.append({
            'kind': 'opening_balance', 'tradeDate': '2026-06-03',
            'account': 'U1111111', 'shares': 200, 'price': 68,
            'cashAmount': -13600, 'fees': 0, 'source': 'reconcile',
            'tag': 'tws_snapshot', 'externalRef': 'tws-position-shares-1',
            'note': 'Snapshot timestamp 2026-06-03T12:00:00.',
        })['event']
        actual = {
            'kind': 'share_trade', 'tradeDate': '2026-06-03',
            'account': 'U1111111', 'shares': 200, 'price': 67,
            'cashAmount': -13400, 'fees': 0, 'source': 'csv_import',
            'externalRef': 'stmt-real-shares-1',
            'note': 'IBKR 2026-06-03, 10:00:00',
        }
        result = self.store.import_events(
            self.book_id, [actual], import_batch_id=_token('batch'),
            client_token_prefix=_token('imp'),
            supersede_tws_event_ids=[adopted['eventId']])
        self.assertEqual(result['supersededTwsBaselines'], 1)
        live = self.store.list_events(self.book_id)['events']
        self.assertEqual(len(live), 1)
        self.assertEqual(live[0]['price'], 67)


class VoidTests(CostBasisStoreTestBase):
    def test_void_hides_the_row_from_the_default_listing(self):
        appended = self.append(self.short_put())
        self.store.void_event(
            self.book_id, appended['event']['eventId'],
            reason='duplicate entry', client_token=_token())
        self.assertEqual(self.store.list_events(self.book_id)['total'], 0)
        with_voided = self.store.list_events(self.book_id, include_voided=True)
        self.assertEqual(with_voided['total'], 1)
        self.assertEqual(with_voided['events'][0]['voidReason'], 'duplicate entry')

    def test_void_never_deletes_the_row(self):
        appended = self.append(self.short_put())
        self.store.void_event(
            self.book_id, appended['event']['eventId'],
            reason='keyed the wrong strike', client_token=_token())
        conn = sqlite3.connect(self.db_path)
        try:
            total = conn.execute('SELECT count(*) FROM cost_basis_events').fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(total, 1)

    def test_void_requires_a_reason(self):
        appended = self.append(self.short_put())
        with self.assertRaises(InvalidRequestError):
            self.store.void_event(
                self.book_id, appended['event']['eventId'],
                reason='  ', client_token=_token())

    def test_double_void_is_rejected(self):
        appended = self.append(self.short_put())
        self.store.void_event(
            self.book_id, appended['event']['eventId'],
            reason='first', client_token=_token())
        with self.assertRaises(EventAlreadyVoidedError):
            self.store.void_event(
                self.book_id, appended['event']['eventId'],
                reason='second', client_token=_token())

    def test_unknown_event_is_rejected(self):
        with self.assertRaises(EventNotFoundError):
            self.store.void_event(
                self.book_id, 'deadbeefdeadbeefdeadbeef',
                reason='nope', client_token=_token())

    def test_voiding_a_close_frees_the_contract_for_a_new_close(self):
        self.append(self.short_put(contracts=-5))
        assigned = self.append(self.put_assignment(contracts=5))
        self.store.void_event(
            self.book_id, assigned['event']['eventId'],
            reason='was actually an expiry', client_token=_token())
        result = self.append({
            'kind': 'option_expiry', 'tradeDate': '2026-07-17',
            'account': 'U1111111', 'right': 'P', 'strike': 45.0,
            'expiry': '20260717', 'contracts': 5, 'cashAmount': 0.0,
        })
        self.assertEqual(result['event']['kind'], 'option_expiry')


class ListingTests(CostBasisStoreTestBase):
    def setUp(self):
        super().setUp()
        self.append(self.short_put(date='2026-06-01', account='U1111111'))
        self.append(self.short_put(date='2026-06-05', strike=44.0, account='U1111111'))
        self.append({
            'kind': 'dividend', 'tradeDate': '2026-06-30', 'account': 'U1111111',
            'cashAmount': 42.0,
        })

    def test_events_are_ordered_by_trade_date(self):
        dates = [item['tradeDate'] for item in
                 self.store.list_events(self.book_id)['events']]
        self.assertEqual(dates, sorted(dates))

    def test_same_day_events_are_listed_by_persisted_broker_time(self):
        book = self.store.create_book(
            account='U1', symbol='GLD', start_date='2026-01-01')
        later = {
            'kind': 'share_trade', 'tradeDate': '2026-08-24',
            'brokerTimestamp': '2026-08-24T15:00:00', 'account': 'U1',
            'shares': 1, 'price': 100, 'cashAmount': -100,
        }
        earlier = {**later, 'brokerTimestamp': '2026-08-24T10:00:00',
                   'shares': 2, 'cashAmount': -200}
        self.store.append_event(book['bookId'], later, client_token=_token())
        self.store.append_event(book['bookId'], earlier, client_token=_token())
        rows = self.store.list_events(book['bookId'])['events']
        self.assertEqual([row['brokerTimestamp'] for row in rows], [
            '2026-08-24T10:00:00', '2026-08-24T15:00:00'])

    def test_account_filter(self):
        result = self.store.list_events(self.book_id, account='U1111111')
        self.assertEqual(result['total'], 3)

    def test_kind_filter(self):
        result = self.store.list_events(self.book_id, kinds=['dividend'])
        self.assertEqual(result['total'], 1)

    def test_date_window_filter(self):
        result = self.store.list_events(
            self.book_id, start_date='2026-06-02', end_date='2026-06-30')
        self.assertEqual(result['total'], 2)

    def test_unknown_kind_is_rejected(self):
        with self.assertRaises(InvalidRequestError):
            self.store.list_events(self.book_id, kinds=['not_a_kind'])

    def test_limit_is_bounded(self):
        with self.assertRaises(InvalidRequestError):
            self.store.list_events(self.book_id, limit=100000)

    def test_paging_walks_every_row_once(self):
        first = self.store.list_events(self.book_id, limit=2, offset=0)
        second = self.store.list_events(self.book_id, limit=2, offset=2)
        self.assertEqual(first['total'], 3)
        self.assertEqual(len(first['events']), 2)
        self.assertEqual(len(second['events']), 1)


class SnapshotTests(CostBasisStoreTestBase):
    def test_snapshot_records_hash_and_summary(self):
        self.append(self.short_put())
        snapshot = self.store.save_snapshot(
            self.book_id, as_of_date='2026-06-30',
            summary={'sharesHeld': 0, 'netCash': 596.75},
            tws_snapshot={'items': []}, reconciled=True)
        self.assertEqual(snapshot['eventCount'], 1)
        self.assertEqual(snapshot['summary']['netCash'], 596.75)
        self.assertTrue(snapshot['reconciled'])
        self.assertEqual(len(snapshot['eventsSha256']), 64)

    def test_hash_changes_when_history_changes(self):
        self.append(self.short_put())
        before = self.store.save_snapshot(
            self.book_id, as_of_date='2026-06-30', summary={})
        self.append(self.short_put(date='2026-06-02', strike=44.0))
        after = self.store.save_snapshot(
            self.book_id, as_of_date='2026-06-30', summary={})
        self.assertNotEqual(before['eventsSha256'], after['eventsSha256'])

    def test_hash_is_stable_for_unchanged_history(self):
        self.append(self.short_put())
        first = self.store.save_snapshot(
            self.book_id, as_of_date='2026-06-30', summary={})
        second = self.store.save_snapshot(
            self.book_id, as_of_date='2026-06-30', summary={})
        self.assertEqual(first['eventsSha256'], second['eventsSha256'])

    def test_snapshots_are_listed_newest_first(self):
        stamps = iter([
            datetime(2026, 6, 30, 12, 0, tzinfo=timezone.utc),
            datetime(2026, 7, 31, 12, 0, tzinfo=timezone.utc),
        ])
        store = CostBasisStore(self.db_path, now=lambda: next(stamps))
        store.save_snapshot(self.book_id, as_of_date='2026-06-30', summary={})
        store.save_snapshot(self.book_id, as_of_date='2026-07-31', summary={})
        listed = self.store.list_snapshots(self.book_id)
        self.assertEqual([item['asOfDate'] for item in listed],
                         ['2026-07-31', '2026-06-30'])


class ResetTests(CostBasisStoreTestBase):
    def setUp(self):
        super().setUp()
        self.append(self.short_put())
        self.append(self.put_assignment())

    def test_confirmation_names_account_symbol_and_live_count(self):
        plan = self.store.reset_confirmation(self.book_id)
        self.assertEqual(plan['phrase'], 'RESET U1111111 TQQQ 2 EVENTS')
        self.assertEqual(plan['eventCount'], 2)

    def test_reset_empties_the_book(self):
        plan = self.store.reset_confirmation(self.book_id)
        result = self.store.reset_book(
            self.book_id, confirmation=plan['phrase'], client_token=_token())
        self.assertEqual(result['removedEvents'], 2)
        self.assertEqual(self.store.list_events(self.book_id)['total'], 0)

    def test_a_wrong_phrase_destroys_nothing(self):
        with self.assertRaises(ResetConfirmationError):
            self.store.reset_book(
                self.book_id, confirmation='RESET TQQQ 99 EVENTS',
                client_token=_token())
        self.assertEqual(self.store.list_events(self.book_id)['total'], 2)

    def test_a_stale_phrase_is_refused(self):
        plan = self.store.reset_confirmation(self.book_id)
        # Someone appends between reading the plan and confirming it: the
        # operator would be deleting a row they never saw.
        self.append(self.short_put(date='2026-06-02', strike=44.0))
        with self.assertRaises(ResetConfirmationError):
            self.store.reset_book(
                self.book_id, confirmation=plan['phrase'], client_token=_token())
        self.assertEqual(self.store.list_events(self.book_id)['total'], 3)

    def test_the_wiped_rows_are_archived_not_lost(self):
        plan = self.store.reset_confirmation(self.book_id)
        self.store.reset_book(
            self.book_id, confirmation=plan['phrase'], client_token=_token(),
            reason='rebuild from statements')
        archived = self.store.list_book_resets(self.book_id, include_events=True)
        self.assertEqual(len(archived), 1)
        self.assertEqual(archived[0]['eventCount'], 2)
        self.assertEqual(archived[0]['reason'], 'rebuild from statements')
        kinds = [item['kind'] for item in archived[0]['events']]
        self.assertEqual(kinds, ['option_trade', 'option_assignment'])
        self.assertEqual(len(archived[0]['eventsSha256']), 64)

    def test_reset_is_idempotent_per_client_token(self):
        plan = self.store.reset_confirmation(self.book_id)
        token = _token()
        first = self.store.reset_book(
            self.book_id, confirmation=plan['phrase'], client_token=token)
        self.append(self.short_put(date='2026-06-03', strike=43.0))
        replay = self.store.reset_book(
            self.book_id, confirmation='anything', client_token=token)
        self.assertTrue(replay['idempotentReplay'])
        self.assertEqual(replay['resetId'], first['resetId'])
        # The replay must not wipe the row appended after the first reset.
        self.assertEqual(self.store.list_events(self.book_id)['total'], 1)

    def test_a_rebuilt_book_accepts_the_same_import_again(self):
        plan = self.store.reset_confirmation(self.book_id)
        self.store.reset_book(
            self.book_id, confirmation=plan['phrase'], client_token=_token())
        rows = [{**self.short_put(), 'source': 'csv_import', 'externalRef': 'stmt-1'}]
        result = self.store.import_events(
            self.book_id, rows, import_batch_id=_token('batch'),
            client_token_prefix=_token('imp'))
        self.assertEqual(result['inserted'], 1)

    def test_reset_leaves_other_books_alone(self):
        other = self.store.create_book(
            account='U1111111', symbol='QQQ', start_date='2026-01-01')
        self.store.append_event(
            other['bookId'], self.short_put(), client_token=_token())
        plan = self.store.reset_confirmation(self.book_id)
        self.store.reset_book(
            self.book_id, confirmation=plan['phrase'], client_token=_token())
        self.assertEqual(self.store.list_events(other['bookId'])['total'], 1)


class DeleteBookTests(CostBasisStoreTestBase):
    def setUp(self):
        super().setUp()
        self.append(self.short_put())
        self.store.save_snapshot(
            self.book_id, as_of_date='2026-06-30', summary={'netCash': 596.75})
        reset_plan = self.store.reset_confirmation(self.book_id)
        self.store.reset_book(
            self.book_id, confirmation=reset_plan['phrase'],
            client_token=_token(), reason='test archive')
        self.append(self.short_put(date='2026-06-02', strike=44.0))

    def test_delete_plan_names_book_and_every_related_row_class(self):
        plan = self.store.delete_confirmation(self.book_id)
        self.assertEqual(
            plan['phrase'],
            'DELETE U1111111 TQQQ 1 EVENTS 1 SNAPSHOTS 1 RESETS')
        self.assertEqual(plan['eventCount'], 1)
        self.assertEqual(plan['liveEventCount'], 1)
        self.assertEqual(plan['voidedEventCount'], 0)
        self.assertEqual(plan['snapshotCount'], 1)
        self.assertEqual(plan['resetCount'], 1)

    def test_wrong_or_stale_phrase_deletes_nothing(self):
        plan = self.store.delete_confirmation(self.book_id)
        self.store.save_snapshot(
            self.book_id, as_of_date='2026-07-31', summary={})
        with self.assertRaises(DeleteConfirmationError):
            self.store.delete_book(
                self.book_id, confirmation=plan['phrase'],
                client_token=_token())
        self.assertEqual(self.store.get_book(self.book_id)['symbol'], 'TQQQ')
        self.assertEqual(self.store.list_events(self.book_id)['total'], 1)
        self.assertEqual(len(self.store.list_snapshots(self.book_id)), 2)
        self.assertEqual(len(self.store.list_book_resets(self.book_id)), 1)

    def test_permanent_delete_removes_only_the_target_book_and_all_artifacts(self):
        other = self.store.create_book(
            account='U2222222', symbol='TQQQ', start_date='2026-01-01')
        self.store.append_event(
            other['bookId'], self.short_put(account='U2222222'),
            client_token=_token())

        plan = self.store.delete_confirmation(self.book_id)
        result = self.store.delete_book(
            self.book_id, confirmation=plan['phrase'], client_token=_token())
        self.assertEqual(result['removedBooks'], 1)
        self.assertEqual(result['removedEvents'], 1)
        self.assertEqual(result['removedSnapshots'], 1)
        self.assertEqual(result['removedResets'], 1)
        with self.assertRaises(BookNotFoundError):
            self.store.get_book(self.book_id)

        conn = sqlite3.connect(self.db_path)
        try:
            for table in ('cost_basis_books', 'cost_basis_events',
                          'cost_basis_snapshots', 'cost_basis_book_resets'):
                count = conn.execute(
                    f'SELECT count(*) FROM {table} WHERE book_id = ?',
                    (self.book_id,),
                ).fetchone()[0]
                self.assertEqual(count, 0, table)
        finally:
            conn.close()
        self.assertEqual(self.store.get_book(other['bookId'])['account'], 'U2222222')
        self.assertEqual(self.store.list_events(other['bookId'])['total'], 1)


class DeliveryCashTests(CostBasisStoreTestBase):
    """A delivery's cash is fully determined; a deviation re-counts premium."""

    def setUp(self):
        super().setUp()
        self.append(self.short_put(contracts=-1, price=1.0, fees=0))

    def _assignment(self, cash):
        return {
            'kind': 'option_assignment', 'tradeDate': '2026-07-17',
            'account': 'U1111111', 'right': 'P', 'strike': 45.0,
            'expiry': '20260717', 'contracts': 1, 'shares': 100,
            'sharesPerContract': 100, 'fees': 0, 'cashAmount': cash,
        }

    def test_exact_delivery_cash_is_accepted(self):
        result = self.append(self._assignment(-4500.0))
        self.assertFalse(result['event']['derivedMismatch'])

    def test_settlement_noise_inside_tolerance_is_accepted(self):
        self.append(self._assignment(-4500.0 - DELIVERY_CASH_TOLERANCE / 2))

    def test_cash_that_re_counts_the_premium_is_refused(self):
        # The 100 of premium is already on the opening event; folding it into
        # the delivery would count it twice.
        with self.assertRaises(InvalidRequestError) as ctx:
            self.append(self._assignment(-4400.0))
        self.assertIn('counted again', str(ctx.exception))
        self.assertEqual(self.store.list_events(self.book_id)['total'], 1)

    def test_a_refused_delivery_leaves_no_row(self):
        with self.assertRaises(InvalidRequestError):
            self.append(self._assignment(-4400.0))
        kinds = [item['kind'] for item
                 in self.store.list_events(self.book_id)['events']]
        self.assertEqual(kinds, ['option_trade'])

    def test_an_omitted_multiplier_is_taken_from_the_contract(self):
        # An adjusted contract must not be closed against the book default.
        store, book = self.store, self.book_id
        store.append_event(book, {
            'kind': 'option_trade', 'tradeDate': '2026-06-01', 'account': 'U1111111',
            'right': 'P', 'strike': 46.0, 'expiry': '20260717', 'contracts': -1,
            'sharesPerContract': 130, 'price': 1.0, 'fees': 0, 'cashAmount': 130.0,
        }, client_token=_token())
        result = store.append_event(book, {
            'kind': 'option_expiry', 'tradeDate': '2026-07-17', 'account': 'U1111111',
            'right': 'P', 'strike': 46.0, 'expiry': '20260717', 'contracts': 1,
            'cashAmount': 0.0,
        }, client_token=_token())
        self.assertEqual(result['event']['sharesPerContract'], 130)


class ExpiryCashTests(CostBasisStoreTestBase):
    """An expiring contract settles no cash beyond its fees."""

    def setUp(self):
        super().setUp()
        self.append(self.short_put(contracts=-1, price=1.0, fees=0))

    def _expiry(self, cash, fees=0):
        return {
            'kind': 'option_expiry', 'tradeDate': '2026-07-17',
            'account': 'U1111111', 'right': 'P', 'strike': 45.0,
            'expiry': '20260717', 'contracts': 1, 'sharesPerContract': 100,
            'fees': fees, 'cashAmount': cash,
        }

    def test_zero_cash_is_accepted(self):
        self.append(self._expiry(0.0))

    def test_fees_only_is_accepted(self):
        self.append(self._expiry(-0.5, fees=0.5))

    def test_cash_out_of_thin_air_is_refused(self):
        # The premium is already on the opening event; letting it in here
        # would add money the market never paid.
        with self.assertRaises(InvalidRequestError) as ctx:
            self.append(self._expiry(100.0))
        self.assertIn('fees only', str(ctx.exception))
        self.assertEqual(self.store.list_events(self.book_id)['total'], 1)

    def test_a_refused_expiry_leaves_the_contract_open(self):
        with self.assertRaises(InvalidRequestError):
            self.append(self._expiry(100.0))
        kinds = [item['kind'] for item
                 in self.store.list_events(self.book_id)['events']]
        self.assertEqual(kinds, ['option_trade'])


class ContractIdentityTests(CostBasisStoreTestBase):
    def test_the_contract_number_is_stored_for_audit(self):
        result = self.append({
            **self.short_put(),
            'conId': 908200664,
            'localSymbol': 'TQQQ 17JUL26 45 P',
        })
        self.assertEqual(result['event']['conId'], 908200664)
        self.assertEqual(result['event']['localSymbol'], 'TQQQ 17JUL26 45 P')

    def test_the_timeline_keeps_adjusted_contracts_apart(self):
        # A 130-share contract must not be closed against the 100-share one.
        self.append(self.short_put(contracts=-1))
        adjusted = {**self.short_put(contracts=-1), 'sharesPerContract': 130}
        adjusted['cashAmount'] = 130.0
        self.append(adjusted)
        with self.assertRaises(PositionOverdrawError):
            self.append({
                'kind': 'option_expiry', 'tradeDate': '2026-07-17',
                'account': 'U1111111', 'right': 'P', 'strike': 45.0,
                'expiry': '20260717', 'contracts': 2, 'sharesPerContract': 130,
                'fees': 0, 'cashAmount': 0.0,
            })

    def test_a_close_cannot_use_another_contract_number_as_its_opening(self):
        self.append({**self.short_put(contracts=-1), 'conId': 111})
        with self.assertRaises(PositionOverdrawError):
            self.append({
                'kind': 'option_expiry', 'tradeDate': '2026-07-17',
                'account': 'U1111111', 'right': 'P', 'strike': 45.0,
                'expiry': '20260717', 'contracts': 1,
                'sharesPerContract': 100, 'conId': 222,
                'fees': 0, 'cashAmount': 0.0,
            })

    def test_an_unidentified_close_is_rejected_when_two_contracts_fit(self):
        self.append({**self.short_put(contracts=-1), 'conId': 111})
        self.append({**self.short_put(contracts=-1), 'conId': 222})
        with self.assertRaises(InvalidRequestError) as ctx:
            self.append({
                'kind': 'option_expiry', 'tradeDate': '2026-07-17',
                'account': 'U1111111', 'right': 'P', 'strike': 45.0,
                'expiry': '20260717', 'contracts': 1,
                'sharesPerContract': 100, 'fees': 0, 'cashAmount': 0.0,
            })
        self.assertIn('conId', str(ctx.exception))

    def test_an_unidentified_option_trade_is_rejected_when_two_contracts_fit(self):
        self.append({**self.short_put(contracts=-1), 'conId': 111})
        self.append({**self.short_put(contracts=-1), 'conId': 222})
        close = self.short_put(
            date='2026-06-02', contracts=1, price=0.5, fees=0)
        with self.assertRaises(InvalidRequestError) as ctx:
            self.append(close)
        self.assertIn('conId', str(ctx.exception))
        self.assertEqual(self.store.list_events(self.book_id)['total'], 2)

    def test_unmapped_local_symbol_is_not_merged_into_the_sole_con_id(self):
        self.append({
            **self.short_put(contracts=-1),
            'conId': 111,
            'localSymbol': 'AAA',
        })
        different = {
            **self.short_put(date='2026-06-02', contracts=1, price=0.5, fees=0),
            'localSymbol': 'BBB',
        }
        with self.assertRaises(InvalidRequestError) as ctx:
            self.append(different)
        self.assertIn('conId', str(ctx.exception))
        self.assertEqual(self.store.list_events(self.book_id)['total'], 1)


class VoidIntegrityTests(CostBasisStoreTestBase):
    def setUp(self):
        super().setUp()
        self.opened = self.append(self.short_put(contracts=-1, price=1.0, fees=0))
        self.assigned = self.append({
            'kind': 'option_assignment', 'tradeDate': '2026-07-17',
            'account': 'U1111111', 'right': 'P', 'strike': 45.0,
            'expiry': '20260717', 'contracts': 1, 'shares': 100,
            'sharesPerContract': 100, 'fees': 0, 'cashAmount': -4500.0,
        })

    def test_voiding_an_opening_that_strands_a_close_is_refused(self):
        with self.assertRaises(PositionOverdrawError):
            self.store.void_event(
                self.book_id, self.opened['event']['eventId'],
                reason='wrong entry', client_token=_token())
        self.assertEqual(self.store.list_events(self.book_id)['total'], 2)

    def test_voiding_in_the_right_order_succeeds(self):
        self.store.void_event(
            self.book_id, self.assigned['event']['eventId'],
            reason='not assigned after all', client_token=_token())
        self.store.void_event(
            self.book_id, self.opened['event']['eventId'],
            reason='wrong entry', client_token=_token())
        self.assertEqual(self.store.list_events(self.book_id)['total'], 0)

    def test_repeating_a_void_token_replays_the_success(self):
        token = _token()
        first = self.store.void_event(
            self.book_id, self.assigned['event']['eventId'],
            reason='not assigned', client_token=token)
        replay = self.store.void_event(
            self.book_id, self.assigned['event']['eventId'],
            reason='not assigned', client_token=token)
        self.assertFalse(first['idempotentReplay'])
        self.assertTrue(replay['idempotentReplay'])
        self.assertEqual(first['event']['eventId'], replay['event']['eventId'])

    def test_a_different_token_on_a_voided_row_still_reports_the_conflict(self):
        self.store.void_event(
            self.book_id, self.assigned['event']['eventId'],
            reason='first', client_token=_token())
        with self.assertRaises(EventAlreadyVoidedError):
            self.store.void_event(
                self.book_id, self.assigned['event']['eventId'],
                reason='second', client_token=_token())


class RebuildTests(CostBasisStoreTestBase):
    def setUp(self):
        super().setUp()
        self.append(self.short_put(date='2026-06-01'))
        self.append(self.short_put(date='2026-06-02', strike=44.0))

    def _phrase(self):
        return self.store.reset_confirmation(self.book_id)['phrase']

    def test_rebuild_replaces_the_book_in_one_step(self):
        result = self.store.rebuild_book(
            self.book_id, [self.short_put(date='2026-07-01', strike=43.0)],
            confirmation=self._phrase(), client_token=_token(),
            import_batch_id=_token('batch'))
        self.assertEqual(result['removedEvents'], 2)
        self.assertEqual(result['inserted'], 1)
        events = self.store.list_events(self.book_id)['events']
        self.assertEqual([item['strike'] for item in events], [43.0])

    def test_a_replacement_that_fails_validation_keeps_the_old_book(self):
        stranded = self.put_assignment(contracts=5)
        with self.assertRaises(PositionOverdrawError):
            self.store.rebuild_book(
                self.book_id, [stranded], confirmation=self._phrase(),
                client_token=_token(), import_batch_id=_token('batch'))
        self.assertEqual(self.store.list_events(self.book_id)['total'], 2)
        self.assertEqual(self.store.list_book_resets(self.book_id), [])

    def test_a_malformed_replacement_never_reaches_the_delete(self):
        with self.assertRaises(InvalidRequestError):
            self.store.rebuild_book(
                self.book_id, [{'kind': 'option_trade', 'tradeDate': 'not-a-date'}],
                confirmation=self._phrase(), client_token=_token(),
                import_batch_id=_token('batch'))
        self.assertEqual(self.store.list_events(self.book_id)['total'], 2)

    def test_a_wrong_phrase_keeps_the_old_book(self):
        with self.assertRaises(ResetConfirmationError):
            self.store.rebuild_book(
                self.book_id, [self.short_put(date='2026-07-01', strike=43.0)],
                confirmation='RESET TQQQ 99 EVENTS', client_token=_token(),
                import_batch_id=_token('batch'))
        self.assertEqual(self.store.list_events(self.book_id)['total'], 2)

    def test_rebuild_archives_what_it_removed(self):
        self.store.rebuild_book(
            self.book_id, [self.short_put(date='2026-07-01', strike=43.0)],
            confirmation=self._phrase(), client_token=_token(),
            import_batch_id=_token('batch'))
        archived = self.store.list_book_resets(self.book_id, include_events=True)
        self.assertEqual(len(archived), 1)
        self.assertEqual(archived[0]['eventCount'], 2)

    def test_rebuild_is_idempotent_per_client_token(self):
        token = _token()
        first = self.store.rebuild_book(
            self.book_id, [self.short_put(date='2026-07-01', strike=43.0)],
            confirmation=self._phrase(), client_token=token,
            import_batch_id=_token('batch'))
        replay = self.store.rebuild_book(
            self.book_id, [self.short_put(date='2026-07-01', strike=43.0)],
            confirmation='anything', client_token=token,
            import_batch_id=_token('batch2'))
        self.assertTrue(replay['idempotentReplay'])
        self.assertEqual(replay['resetId'], first['resetId'])
        self.assertEqual(self.store.list_events(self.book_id)['total'], 1)


class ResetCountTests(CostBasisStoreTestBase):
    def test_the_phrase_counts_every_row_the_wipe_removes(self):
        appended = self.append(self.short_put())
        voided = self.append(self.short_put(date='2026-06-02', strike=44.0))
        self.store.void_event(
            self.book_id, voided['event']['eventId'],
            reason='mistake', client_token=_token())

        plan = self.store.reset_confirmation(self.book_id)
        self.assertEqual(plan['eventCount'], 2)
        self.assertEqual(plan['liveEventCount'], 1)
        self.assertEqual(plan['voidedEventCount'], 1)
        self.assertEqual(plan['phrase'], 'RESET U1111111 TQQQ 2 EVENTS')

        # The old phrase, which counted only live rows, must no longer work.
        with self.assertRaises(ResetConfirmationError):
            self.store.reset_book(
                self.book_id, confirmation='RESET TQQQ 1 EVENTS',
                client_token=_token())

        result = self.store.reset_book(
            self.book_id, confirmation=plan['phrase'], client_token=_token())
        self.assertEqual(result['removedEvents'], 2)
        self.assertEqual(appended['event']['bookId'], self.book_id)


class FuturesLedgerStoreTests(CostBasisStoreTestBase):
    def setUp(self):
        super().setUp()
        self.future_book = self.store.create_book(
            account='U1111111', symbol='ES', sec_type='FUT', start_date='2026-01-01',
            default_shares_per_contract=50)
        self.future_book_id = self.future_book['bookId']

    def append_future(self, event):
        return self.store.append_event(
            self.future_book_id, event, client_token=_token())

    @staticmethod
    def future_trade(**overrides):
        event = {
            'kind': 'futures_trade', 'tradeDate': '2026-08-01',
            'account': 'U1111111', 'futureExpiry': '202609',
            'futureConId': 1001, 'futureLocalSymbol': 'ESU6',
            'futureContracts': 1, 'sharesPerContract': 50,
            'price': 5000, 'fees': 0, 'cashAmount': 0,
        }
        event.update(overrides)
        return event

    def test_future_trade_and_roll_round_trip_all_contract_fields(self):
        self.append_future(self.future_trade())
        rolled = self.append_future({
            'kind': 'futures_roll', 'tradeDate': '2026-08-24',
            'account': 'U1111111', 'futureExpiry': '202609',
            'futureConId': 1001, 'futureLocalSymbol': 'ESU6',
            'futureContracts': 1, 'sharesPerContract': 50,
            'price': 5100, 'rollToExpiry': '202612',
            'rollToConId': 1002, 'rollToLocalSymbol': 'ESZ6',
            'rollToPrice': 5120, 'rollGroup': 'roll-test-1',
            'fees': 4, 'cashAmount': -4,
        })['event']
        self.assertEqual(rolled['futureExpiry'], '202609')
        self.assertEqual(rolled['rollToExpiry'], '202612')
        self.assertEqual(rolled['rollToPrice'], 5120.0)
        self.assertEqual(rolled['rollGroup'], 'roll-test-1')

    def test_negative_futures_prices_are_valid_and_round_trip(self):
        opened = self.append_future(self.future_trade(
            tradeDate='2020-04-01',
            futureExpiry='202005', futureConId=5001,
            futureLocalSymbol='CLK20', sharesPerContract=1000,
            price=-37.63))['event']
        self.assertEqual(opened['price'], -37.63)
        rolled = self.append_future({
            'kind': 'futures_roll', 'tradeDate': '2020-04-20',
            'account': 'U1111111', 'futureExpiry': '202005',
            'futureConId': 5001, 'futureLocalSymbol': 'CLK20',
            'futureContracts': 1, 'sharesPerContract': 1000,
            'price': -30, 'rollToExpiry': '202006',
            'rollToConId': 5002, 'rollToLocalSymbol': 'CLM20',
            'rollToPrice': -20, 'rollGroup': 'negative-roll',
            'fees': 0, 'cashAmount': 0,
        })['event']
        self.assertEqual(rolled['price'], -30)
        self.assertEqual(rolled['rollToPrice'], -20)

    def test_month_and_last_trade_date_share_one_futures_timeline(self):
        self.append_future(self.future_trade(futureExpiry='202609'))
        self.append_future(self.future_trade(
            tradeDate='2026-08-02', futureExpiry='20260918',
            futureContracts=-1, price=5010))
        self.assertEqual(
            future_key({'account': 'U1111111', 'futureExpiry': '202609',
                        'sharesPerContract': 50}),
            future_key({'account': 'U1111111', 'futureExpiry': '20260918',
                        'sharesPerContract': 50}))

    def test_book_type_boundary_rejects_cross_asset_events(self):
        with self.assertRaises(InvalidRequestError):
            self.append(self.future_trade())
        with self.assertRaises(InvalidRequestError):
            self.append_future({
                'kind': 'share_trade', 'tradeDate': '2026-08-01',
                'account': 'U1111111', 'shares': 100, 'price': 50,
                'fees': 0, 'cashAmount': -5000,
            })
        with self.assertRaises(InvalidRequestError):
            wrong_option = self.short_put()
            wrong_option['optionSecType'] = 'OPT'
            self.append_future(wrong_option)

    def test_roll_cannot_transfer_a_month_the_ledger_does_not_hold(self):
        with self.assertRaises(PositionOverdrawError):
            self.append_future({
                'kind': 'futures_roll', 'tradeDate': '2026-08-24',
                'account': 'U1111111', 'futureExpiry': '202609',
                'futureContracts': 1, 'sharesPerContract': 50,
                'price': 5100, 'rollToExpiry': '202612',
                'rollToPrice': 5120, 'rollGroup': 'roll-test-2',
                'fees': 0, 'cashAmount': 0,
            })

    def test_fop_assignment_opens_one_future_at_strike_with_fees_only_cash(self):
        self.append_future({
            'kind': 'option_trade', 'optionSecType': 'FOP',
            'tradeDate': '2026-08-01', 'account': 'U1111111',
            'right': 'P', 'strike': 5000, 'expiry': '20260821',
            'contracts': -1, 'sharesPerContract': 50, 'price': 50,
            'fees': 0, 'cashAmount': 2500,
        })
        assigned = self.append_future({
            'kind': 'option_assignment', 'optionSecType': 'FOP',
            'tradeDate': '2026-08-21', 'account': 'U1111111',
            'right': 'P', 'strike': 5000, 'expiry': '20260821',
            'contracts': 1, 'sharesPerContract': 50,
            'futureExpiry': '202609', 'futureContracts': 1,
            'fees': 3, 'cashAmount': -3,
        })['event']
        self.assertIsNone(assigned['shares'])
        self.assertEqual(assigned['futureContracts'], 1.0)
        self.assertEqual(assigned['price'], 5000.0)
        with self.assertRaises(InvalidRequestError):
            bad = dict(self.future_trade(tradeDate='2026-08-22'))
            bad['cashAmount'] = -250000
            self.append_future(bad)

    def test_complete_csv_history_supersedes_an_adopted_future_baseline(self):
        adopted = self.append_future(self.future_trade(
            tradeDate='2026-08-26', source='reconcile', tag='tws_snapshot',
            note='Snapshot timestamp 2026-08-26T12:00:00.'))['event']
        imported = self.future_trade(
            tradeDate='2026-08-25', source='csv_import',
            externalRef='csv-fut-1', note='IBKR 2026-08-25, 10:00:00')
        result = self.store.import_events(
            self.future_book_id, [imported], import_batch_id=_token('batch'),
            client_token_prefix=_token('prefix'),
            supersede_tws_event_ids=[adopted['eventId']])
        self.assertEqual(result['inserted'], 1)
        self.assertEqual(result['supersededTwsBaselines'], 1)
        rows = self.store.list_events(
            self.future_book_id, include_voided=True)['events']
        baseline = next(row for row in rows if row['eventId'] == adopted['eventId'])
        self.assertIsNotNone(baseline['voidedAtUtc'])

    def test_incremental_csv_after_snapshot_keeps_the_adopted_baseline(self):
        adopted = self.append_future(self.future_trade(
            tradeDate='2026-08-26', source='reconcile', tag='tws_snapshot',
            note='Snapshot timestamp 2026-08-26T12:00:00.'))['event']
        imported = self.future_trade(
            tradeDate='2026-08-27', futureContracts=-1, source='csv_import',
            externalRef='csv-fut-close', note='IBKR 2026-08-27, 10:00:00')
        result = self.store.import_events(
            self.future_book_id, [imported], import_batch_id=_token('batch'),
            client_token_prefix=_token('prefix'))
        self.assertEqual(result['inserted'], 1)
        self.assertEqual(result['supersededTwsBaselines'], 0)
        rows = self.store.list_events(
            self.future_book_id, include_voided=True)['events']
        baseline = next(row for row in rows if row['eventId'] == adopted['eventId'])
        self.assertIsNone(baseline['voidedAtUtc'])

    def test_roll_target_identity_can_reconstruct_an_adopted_new_month(self):
        adopted = self.append_future(self.future_trade(
            tradeDate='2026-08-26', futureExpiry='202612', futureConId=1002,
            futureLocalSymbol='ESZ6', source='reconcile', tag='tws_snapshot',
            note='Snapshot timestamp 2026-08-26T12:00:00.'))['event']
        old = self.future_trade(
            tradeDate='2026-08-01', source='csv_import',
            externalRef='csv-old-month', note='IBKR 2026-08-01, 10:00:00')
        roll = {
            'kind': 'futures_roll', 'tradeDate': '2026-08-24',
            'account': 'U1111111', 'futureExpiry': '202609',
            'futureConId': 1001, 'futureLocalSymbol': 'ESU6',
            'futureContracts': 1, 'sharesPerContract': 50, 'price': 5100,
            'rollToExpiry': '202612', 'rollToConId': 1002,
            'rollToLocalSymbol': 'ESZ6', 'rollToPrice': 5120,
            'rollGroup': 'roll-csv-target', 'fees': 0, 'cashAmount': 0,
            'source': 'csv_import', 'externalRef': 'csv-roll-target',
            'note': 'IBKR 2026-08-24, 10:00:00',
        }
        result = self.store.import_events(
            self.future_book_id, [old, roll], import_batch_id=_token('batch'),
            client_token_prefix=_token('prefix'),
            supersede_tws_event_ids=[adopted['eventId']])
        self.assertEqual(result['inserted'], 2)
        self.assertEqual(result['supersededTwsBaselines'], 1)


class MigrationTests(unittest.TestCase):
    """A v1 database holding real events must survive the upgrade."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = pathlib.Path(self._tmp.name) / 'v1.db'

    def _build_v1(self):
        # Reproduce the v1 shape: everything except the resets table.
        import cost_basis_store as module
        conn = sqlite3.connect(self.db_path, isolation_level=None)
        conn.execute('PRAGMA auto_vacuum = INCREMENTAL')
        conn.execute('PRAGMA journal_mode = WAL')
        conn.execute('BEGIN IMMEDIATE')
        for statement in module._SCHEMA_STATEMENTS:
            if 'cost_basis_book_resets' in statement:
                continue
            if 'CREATE TABLE cost_basis_books' in statement:
                statement = statement.replace(
                    '        account                     TEXT NOT NULL,\n', '')
            elif 'idx_cost_basis_books_account_symbol' in statement:
                statement = module._V4_BOOK_INDEX_SQL
            conn.execute(statement)
        conn.execute('PRAGMA user_version = 1')
        conn.execute('COMMIT')
        conn.close()

    def _build_real_v2(self):
        """Build the pre-FUT table shape, including its legacy kind CHECK."""
        self._build_v1()
        import cost_basis_store as module
        conn = sqlite3.connect(self.db_path, isolation_level=None)
        conn.execute('BEGIN IMMEDIATE')
        for statement in module._V2_TABLE_STATEMENTS:
            conn.execute(statement)
        for name in (
                'idx_cost_basis_events_external', 'idx_cost_basis_events_book_seq',
                'idx_cost_basis_events_book_date', 'idx_cost_basis_events_batch'):
            conn.execute(f'DROP INDEX {name}')
        conn.execute('ALTER TABLE cost_basis_events RENAME TO cost_basis_events_v3')
        conn.execute("""
            CREATE TABLE cost_basis_events (
                event_id TEXT PRIMARY KEY,
                book_id TEXT NOT NULL REFERENCES cost_basis_books(book_id),
                seq INTEGER NOT NULL,
                client_token TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL CHECK (kind IN (
                    'opening_balance','share_trade','option_trade',
                    'option_assignment','option_exercise','option_expiry',
                    'dividend','fee','split','manual_adjust')),
                trade_date TEXT NOT NULL,
                account TEXT NOT NULL DEFAULT '',
                right TEXT CHECK (right IN ('C','P') OR right IS NULL),
                strike REAL, expiry TEXT, con_id INTEGER, local_symbol TEXT,
                shares_per_contract INTEGER, contracts REAL, shares REAL,
                price REAL, cash_amount REAL NOT NULL, fees REAL NOT NULL DEFAULT 0,
                split_ratio REAL,
                include_in_cost INTEGER NOT NULL DEFAULT 1,
                tag TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual',
                external_ref TEXT, import_batch_id TEXT,
                derived_mismatch INTEGER NOT NULL DEFAULT 0,
                note TEXT NOT NULL DEFAULT '', created_at_utc TEXT NOT NULL,
                voided_at_utc TEXT, voided_by_event_id TEXT, void_reason TEXT
            )
        """)
        conn.execute('DROP TABLE cost_basis_events_v3')
        conn.execute("""
            CREATE UNIQUE INDEX idx_cost_basis_events_external
            ON cost_basis_events(book_id, account, external_ref)
            WHERE external_ref IS NOT NULL
        """)
        conn.execute("""
            CREATE UNIQUE INDEX idx_cost_basis_events_book_seq
            ON cost_basis_events(book_id, seq)
        """)
        conn.execute("""
            CREATE INDEX idx_cost_basis_events_book_date
            ON cost_basis_events(book_id, trade_date, seq)
        """)
        conn.execute("""
            CREATE INDEX idx_cost_basis_events_batch
            ON cost_basis_events(import_batch_id)
            WHERE import_batch_id IS NOT NULL
        """)
        conn.execute('PRAGMA user_version = 2')
        conn.execute('COMMIT')
        conn.close()

    def test_v1_data_survives_the_upgrade(self):
        self._build_v1()
        store = CostBasisStore(self.db_path)
        # Writing through a v1 file must fail until it is migrated.
        with self.assertRaises(StoreUnavailableError):
            store.list_books()
        store.initialize()

        conn = sqlite3.connect(self.db_path)
        try:
            self.assertEqual(
                conn.execute('PRAGMA user_version').fetchone()[0], SCHEMA_USER_VERSION)
            tables = {row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
        finally:
            conn.close()
        self.assertIn('cost_basis_book_resets', tables)

    def test_events_written_before_the_upgrade_are_still_there(self):
        self._build_v1()
        conn = sqlite3.connect(self.db_path, isolation_level=None)
        conn.execute(
            "INSERT INTO cost_basis_books (book_id, symbol, sec_type, currency, "
            "default_shares_per_contract, start_date, note, created_at_utc, "
            "updated_at_utc) VALUES ('bookaaaa1', 'TQQQ', 'STK', 'USD', 100, "
            "'2026-01-01', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
        conn.execute(
            "INSERT INTO cost_basis_events (event_id, book_id, seq, client_token, "
            "kind, trade_date, account, contracts, right, strike, expiry, price, "
            "cash_amount, fees, created_at_utc) VALUES ('evtaaaa1', 'bookaaaa1', 1, "
            "'tokaaaaa1', 'option_trade', '2026-06-01', 'U1111111', -5, 'P', 45.0, "
            "'20260717', 1.2, 600.0, 0, '2026-06-01T00:00:00Z')")
        conn.close()

        store = CostBasisStore(self.db_path).initialize()
        events = store.list_events('bookaaaa1')
        self.assertEqual(events['total'], 1)
        self.assertEqual(events['events'][0]['cashAmount'], 600.0)
        self.assertEqual(store.get_book('bookaaaa1')['account'], 'U1111111')
        self.assertEqual(store.list_book_resets('bookaaaa1'), [])

    def test_mixed_account_v4_book_stays_legacy_and_is_not_split(self):
        self._build_v1()
        conn = sqlite3.connect(self.db_path, isolation_level=None)
        conn.execute(
            "INSERT INTO cost_basis_books (book_id, symbol, sec_type, currency, "
            "default_shares_per_contract, start_date, note, created_at_utc, "
            "updated_at_utc) VALUES ('bookmix01', 'TQQQ', 'STK', 'USD', 100, "
            "'2026-01-01', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
        for seq, account in enumerate(('U1111111', 'U2222222'), start=1):
            conn.execute(
                "INSERT INTO cost_basis_events (event_id, book_id, seq, client_token, "
                "kind, trade_date, account, shares, price, cash_amount, fees, "
                "created_at_utc) VALUES (?, 'bookmix01', ?, ?, 'share_trade', "
                "'2026-06-01', ?, 1, 50, -50, 0, '2026-06-01T00:00:00Z')",
                (f'eventmix{seq}', seq, f'tokenmix{seq}', account),
            )
        conn.close()

        store = CostBasisStore(self.db_path).initialize()
        self.assertEqual(store.get_book('bookmix01')['account'], '')
        self.assertEqual(store.list_events('bookmix01')['total'], 2)
        separate = store.create_book(
            account='U1111111', symbol='TQQQ', start_date='2026-01-01')
        self.assertEqual(separate['account'], 'U1111111')

    def test_migration_is_idempotent(self):
        self._build_v1()
        CostBasisStore(self.db_path).initialize()
        CostBasisStore(self.db_path).initialize()
        conn = sqlite3.connect(self.db_path)
        try:
            self.assertEqual(
                conn.execute('PRAGMA user_version').fetchone()[0], SCHEMA_USER_VERSION)
        finally:
            conn.close()

    def test_real_v2_event_table_is_atomically_rebuilt_for_futures(self):
        self._build_real_v2()
        conn = sqlite3.connect(self.db_path, isolation_level=None)
        conn.execute(
            "INSERT INTO cost_basis_books (book_id, symbol, sec_type, currency, "
            "default_shares_per_contract, start_date, note, created_at_utc, "
            "updated_at_utc) VALUES ('bookv2aa1', 'ES', 'STK', 'USD', 100, "
            "'2026-01-01', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
        conn.execute(
            "INSERT INTO cost_basis_events (event_id, book_id, seq, client_token, "
            "kind, trade_date, account, shares, price, cash_amount, fees, "
            "created_at_utc) VALUES ('eventv2a1', 'bookv2aa1', 1, 'tokenv2a1', "
            "'share_trade', '2026-06-01', 'U1', 10, 100, -1000, 0, "
            "'2026-06-01T00:00:00Z')")
        conn.close()

        store = CostBasisStore(self.db_path).initialize()
        event = store.list_events('bookv2aa1')['events'][0]
        self.assertEqual(event['shares'], 10.0)
        self.assertIsNone(event['futureExpiry'])
        future = store.create_book(
            account='U1', symbol='ES', sec_type='FUT', start_date='2026-01-01',
            default_shares_per_contract=50)
        self.assertEqual(future['secType'], 'FUT')
        stored = store.append_event(future['bookId'], {
            'kind': 'futures_trade', 'tradeDate': '2026-08-01', 'account': 'U1',
            'futureExpiry': '202609', 'futureContracts': 1,
            'sharesPerContract': 50, 'price': 5000, 'fees': 0, 'cashAmount': 0,
        }, client_token=_token())['event']
        self.assertEqual(stored['kind'], 'futures_trade')

    def test_v3_notes_are_migrated_into_the_official_broker_timestamp_column(self):
        import cost_basis_store as module
        store = CostBasisStore(self.db_path).initialize()
        book = store.create_book(
            account='U1', symbol='TQQQ', start_date='2026-01-01')
        store.append_event(book['bookId'], {
            'kind': 'share_trade', 'tradeDate': '2026-06-03', 'account': 'U1',
            'shares': 1, 'price': 100, 'cashAmount': -100,
            'note': 'IBKR 2026-06-03, 10:11:12',
        }, client_token=_token())

        conn = sqlite3.connect(self.db_path, isolation_level=None)
        conn.execute('BEGIN IMMEDIATE')
        for name in (
                'idx_cost_basis_events_external', 'idx_cost_basis_events_book_seq',
                'idx_cost_basis_events_book_date', 'idx_cost_basis_events_batch'):
            conn.execute(f'DROP INDEX {name}')
        conn.execute('ALTER TABLE cost_basis_events RENAME TO cost_basis_events_v4')
        v3_sql = module._SCHEMA_STATEMENTS[2].replace(
            '        broker_timestamp    TEXT,\n', '')
        conn.execute(v3_sql)
        v3_columns = [column for column in module._EVENT_COLUMNS
                      if column != 'broker_timestamp']
        columns_sql = ', '.join(v3_columns)
        conn.execute(
            f'INSERT INTO cost_basis_events ({columns_sql}) '
            f'SELECT {columns_sql} FROM cost_basis_events_v4')
        conn.execute('DROP TABLE cost_basis_events_v4')
        conn.execute(module._SCHEMA_STATEMENTS[3])
        conn.execute(module._SCHEMA_STATEMENTS[4])
        conn.execute('CREATE INDEX idx_cost_basis_events_book_date '
                     'ON cost_basis_events(book_id, trade_date, seq)')
        conn.execute(module._SCHEMA_STATEMENTS[6])
        conn.execute('PRAGMA user_version = 3')
        conn.execute('COMMIT')
        conn.close()

        migrated = CostBasisStore(self.db_path).initialize()
        row = migrated.list_events(book['bookId'])['events'][0]
        self.assertEqual(row['brokerTimestamp'], '2026-06-03T10:11:12')


class DescribeTests(CostBasisStoreTestBase):
    def test_describe_reports_live_counts(self):
        self.append(self.short_put())
        described = self.store.describe()
        self.assertEqual(described['schemaVersion'], SCHEMA_USER_VERSION)
        self.assertEqual(described['bookCount'], 1)
        self.assertEqual(described['eventCount'], 1)
        self.assertGreater(described['allocatedBytes'], 0)


if __name__ == '__main__':
    unittest.main()
