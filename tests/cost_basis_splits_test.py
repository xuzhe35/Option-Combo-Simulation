"""Split groups in the store (A1 phases 1 and 2).

See CODE PLAN/COST_BASIS_CORPORATE_ACTIONS_PLAN.md §15. A standard split is
written and voided only as a whole group (append_split_group /
void_split_group) and every group is re-proven after each write that touches
its account. The ordering, strike and identity helpers are shared with the
browser core and checked against the same fixtures. Every database here is
a temporary file; all data is synthetic.
"""

import hashlib
import json
import pathlib
import sqlite3
import subprocess
import tempfile
import unittest
import uuid

import cost_basis_store as module
from cost_basis_store import (
    SCHEMA_USER_VERSION,
    CostBasisStore,
    EventAlreadyVoidedError,
    InvalidRequestError,
    PositionOverdrawError,
    StoreUnavailableError,
    _EVENT_ORDER_SQL,
    _option_movements,
    _option_root,
    _resolve_contract_identity_rows,
    _split_strike_cents,
    _strike_cents,
)

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = pathlib.Path(__file__).resolve().parent / 'fixtures'
OCC = json.loads((FIXTURES / 'occ_57592_tqqq_strikes.json').read_text(encoding='utf-8'))
ORDER = json.loads(
    (FIXTURES / 'cost_basis_event_order_vectors.json').read_text(encoding='utf-8'))

ACCOUNT = 'U1111111'
NEW_COLUMNS = (
    'split_group', 'split_rule_ref', 'split_rounding', 'split_to_strike',
    'split_to_contracts', 'split_to_con_id', 'split_to_local_symbol',
    'split_standard_confirmed',
)
V10_COLUMN_BLOCK = """        split_group         TEXT,
        split_rule_ref      TEXT,
        split_rounding      TEXT,
        split_to_strike     REAL,
        split_to_contracts  REAL,
        split_to_con_id     INTEGER,
        split_to_local_symbol TEXT,
        split_standard_confirmed INTEGER NOT NULL DEFAULT 0
                            CHECK (split_standard_confirmed IN (0, 1)),
"""


def _token():
    return f'tok-{uuid.uuid4().hex[:16]}'


def _cents(text):
    whole, fraction = text.split('.')
    return int(whole) * 100 + int(fraction)


def _credentials(store, book_id):
    identity = next(book for book in store.list_books(include_archived=True)
                    if book['bookId'] == book_id)
    return {'expected_ledger_version': store.ledger_version(book_id),
            'book_identity': identity}


class TempStoreCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db_path = pathlib.Path(self._tmp.name) / 'cost_basis.db'
        self.store = CostBasisStore(self.db_path).initialize()
        self.book_id = self.store.create_book(
            account=ACCOUNT, symbol='TQQQ', start_date='2025-10-01')['bookId']

    def append(self, event):
        return self.store.append_event(self.book_id, event, client_token=_token())

    def raw(self):
        conn = sqlite3.connect(self.db_path, isolation_level=None)
        conn.row_factory = sqlite3.Row
        return conn


class StrikeRuleTests(unittest.TestCase):
    def test_every_occ_57592_series_is_integer_cents_halved_half_up(self):
        self.assertEqual(len(OCC['pairs']), 167)
        for old, new in OCC['pairs']:
            self.assertEqual(_split_strike_cents(_strike_cents(float(old)), 2), _cents(new), old)
            self.assertEqual(_split_strike_cents(_strike_cents(old), 2), _cents(new), old)
        # The three half-cent series are why the rule is integer arithmetic.
        wrong = [old for old, new in OCC['pairs'] if f'{float(old) / 2:.2f}' != new]
        self.assertEqual(wrong, [old for old, _ in OCC['halfCentCases']])

    def test_strike_cents_matches_the_browser_rules(self):
        self.assertEqual(_strike_cents(49.99), 4999)
        self.assertEqual(_strike_cents('49.990'), 4999)
        self.assertEqual(_strike_cents('50'), 5000)
        self.assertEqual(_strike_cents(0.1 + 0.2), 30)
        for bad in ('49.991', '49.99000001', 33.333, 0, -1, '0', '-5', '', None,
                    'abc', '1e3', float('nan'), float('inf'), True):
            self.assertIsNone(_strike_cents(bad), repr(bad))

    def test_only_integer_forward_ratios_adjust(self):
        self.assertEqual(_split_strike_cents(10000, 3), 3333)
        self.assertEqual(_split_strike_cents(10001, 3), 3334)
        self.assertEqual(_split_strike_cents(10000, 2.0), 5000)
        self.assertIsNone(_split_strike_cents(1, 3))
        for ratio in (1, 0, -2, 2.5, 1.5, 101, '2', None, True):
            self.assertIsNone(_split_strike_cents(10000, ratio), repr(ratio))
        self.assertIsNone(_split_strike_cents(49.99, 2))

    def test_option_root_keeps_adjusted_classes_apart(self):
        cases = {
            'TQQQ  251219P00100000': 'TQQQ', 'TQQQ251219P00100000': 'TQQQ',
            '2TQQQ 251219P00050000': '2TQQQ', '2TQQQ251219P00050000': '2TQQQ',
            'TQQQ 19DEC25 100 P': 'TQQQ', '2tqqq 19dec25 50 p': '2TQQQ',
            'BRK.B 19DEC25 500 C': 'BRK.B', '': '', None: '',
        }
        for symbol, root in cases.items():
            self.assertEqual(_option_root(symbol), root, symbol)

    def test_an_option_split_row_moves_two_series(self):
        row = {'kind': 'option_split', 'account': ACCOUNT, 'right': 'P', 'strike': 100.0,
               'expiry': '20251219', 'shares_per_contract': 100, 'con_id': 1001,
               'local_symbol': 'TQQQ  251219P00100000', 'contracts': 2.0,
               'split_to_strike': 50.0, 'split_to_contracts': -4.0,
               'split_to_con_id': 3003, 'split_to_local_symbol': 'TQQQ  251219P00050000'}
        out, into = _option_movements(row)
        self.assertEqual((out['side'], out['strike'], out['contracts'], out['con_id']),
                         ('split_out', 100.0, 2.0, 1001))
        self.assertEqual((into['side'], into['strike'], into['contracts'], into['con_id']),
                         ('split_in', 50.0, -4.0, 3003))
        trade = {**row, 'kind': 'option_trade'}
        self.assertEqual([m['side'] for m in _option_movements(trade)], ['trade'])
        self.assertEqual(_option_movements({'kind': 'share_trade'}), [])


class IdentityEpochTests(unittest.TestCase):
    def test_epochs_keep_a_pre_and_post_split_contract_apart(self):
        occ50 = 'TQQQ  251219P00050000'
        rows = [
            {'trade_date': '2025-11-03', 'con_id': 1001, 'local_symbol': occ50, 'split_group': None},
            {'trade_date': '2025-11-10', 'con_id': 1001, 'local_symbol': occ50, 'split_group': None},
            {'trade_date': '2025-11-24', 'con_id': 2002, 'local_symbol': occ50, 'split_group': None},
            {'trade_date': '2025-12-01', 'con_id': None, 'local_symbol': None, 'split_group': None},
        ]
        plain = _resolve_contract_identity_rows(rows)
        self.assertTrue(plain[-1][2], 'without epochs the manual row is ambiguous')

        def epoch_of(row):
            return 1 if row['trade_date'] >= '2025-11-20' else 0
        resolved = _resolve_contract_identity_rows(rows, epoch_of)
        self.assertEqual([item[1] for item in resolved],
                         ['con:1001', 'con:1001', 'con:2002@s1', 'con:2002@s1'])
        self.assertFalse(any(item[2] for item in resolved))
        self.assertEqual([item[0] for item in resolved], rows, 'order is preserved')

    def test_no_epoch_leaves_identities_unchanged(self):
        rows = [{'trade_date': '2025-11-03', 'con_id': 7, 'local_symbol': None,
                 'split_group': None}]
        self.assertEqual(_resolve_contract_identity_rows(rows, lambda row: 0),
                         _resolve_contract_identity_rows(rows))


class StoreEpochTimelineTests(TempStoreCase):
    """S1 at the store: a group header (inserted directly, as phase 2 will
    write it) separates a pre-split and a post-split contract at one strike."""

    OCC50 = 'TQQQ  251219P00050000'

    def _put(self, date, contracts, cash, **extra):
        return {'kind': 'option_trade', 'tradeDate': date, 'right': 'P', 'strike': 50,
                'expiry': '20251219', 'contracts': contracts,
                'price': abs(cash) / 100 / abs(contracts), 'sharesPerContract': 100,
                'cashAmount': cash, **extra}

    def _history(self, grouped):
        self.append(self._put('2025-11-03', -1, 300.0, conId=1001, localSymbol=self.OCC50))
        self.append(self._put('2025-11-10', 1, -100.0, conId=1001, localSymbol=self.OCC50))
        conn = self.raw()
        try:
            conn.execute(
                'INSERT INTO cost_basis_events (event_id, book_id, seq, client_token, kind, '
                'trade_date, account, split_ratio, split_group, cash_amount, created_at_utc) '
                "VALUES ('header', ?, 3, ?, 'split', '2025-11-20', ?, 2, ?, 0, "
                "'2025-11-20T00:00:00Z')",
                (self.book_id, _token(), ACCOUNT, 'g1' if grouped else None))
        finally:
            conn.close()
        return self.append(self._put('2025-11-24', -1, 250.0, conId=2002,
                                     localSymbol=self.OCC50))['event']

    # Typed by hand: no conId, no local symbol. An expiry must close a
    # position, so the store has to find which contract it belongs to.
    EXPIRY = {'kind': 'option_expiry', 'tradeDate': '2025-12-19', 'right': 'P',
              'strike': 50, 'expiry': '20251219', 'contracts': 1,
              'sharesPerContract': 100, 'cashAmount': 0}

    def test_a_manual_expiry_after_a_group_closes_the_post_split_contract(self):
        opened = self._history(grouped=True)
        self.append(self.EXPIRY)
        # Voiding the post-split opening now strands that expiry: a position
        # error, not an identity ambiguity.
        with self.assertRaises(module.PositionOverdrawError):
            self.store.void_event(self.book_id, opened['eventId'], reason='test',
                                  client_token=_token())

    def test_without_a_group_the_same_rows_stay_fail_closed(self):
        self._history(grouped=False)
        with self.assertRaises(InvalidRequestError):
            self.append(self.EXPIRY)


class OrderVectorTests(TempStoreCase):
    def test_sql_order_matches_the_shared_vectors(self):
        conn = self.raw()
        try:
            for case in ORDER['cases']:
                conn.execute('DELETE FROM cost_basis_events')
                for item in case['events']:
                    conn.execute(
                        'INSERT INTO cost_basis_events (event_id, book_id, seq, client_token, '
                        'kind, trade_date, broker_timestamp, account, cash_amount, '
                        'split_group, created_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
                        (item['id'], self.book_id, item['seq'], _token(),
                         'split' if item.get('splitGroup') else 'fee', item['tradeDate'],
                         item.get('brokerTimestamp'), ACCOUNT, item.get('splitGroup'),
                         '2025-01-01T00:00:00Z'))
                ordered = [row['event_id'] for row in conn.execute(
                    f'SELECT event_id FROM cost_basis_events ORDER BY {_EVENT_ORDER_SQL}')]
                self.assertEqual(ordered, case['expected'], case['name'])
        finally:
            conn.close()


class SchemaV10Tests(TempStoreCase):
    def test_fresh_database_can_store_split_groups(self):
        conn = self.raw()
        try:
            self.assertEqual(conn.execute('PRAGMA user_version').fetchone()[0], 10)
            columns = {row['name'] for row in conn.execute('PRAGMA table_info(cost_basis_events)')}
            self.assertTrue(set(NEW_COLUMNS) <= columns)
            indexes = {row['name'] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index'")}
            self.assertIn('idx_cost_basis_events_split_group', indexes)
            conn.execute(
                'INSERT INTO cost_basis_events (event_id, book_id, seq, client_token, kind, '
                "trade_date, cash_amount, created_at_utc) VALUES ('x', ?, 99, ?, "
                "'option_split', '2025-11-20', 0, '2025-01-01T00:00:00Z')",
                (self.book_id, _token()))
        finally:
            conn.close()

    def test_split_rows_are_refused_outside_a_group_write(self):
        rejected = [
            {'kind': 'option_split', 'tradeDate': '2025-11-20', 'cashAmount': 0},
            {'kind': 'split', 'tradeDate': '2025-11-20', 'splitRatio': 2, 'cashAmount': 0,
             'splitGroup': 'g1'},
            {'kind': 'split', 'tradeDate': '2025-11-20', 'splitRatio': 2, 'cashAmount': 0,
             'splitRuleRef': 'OCC #57592'},
            {'kind': 'option_trade', 'tradeDate': '2025-11-03', 'right': 'P', 'strike': 50,
             'expiry': '20251219', 'contracts': -1, 'price': 3, 'cashAmount': 300,
             'splitStandardConfirmed': True},
            {'kind': 'option_trade', 'tradeDate': '2025-11-03', 'right': 'P', 'strike': 50,
             'expiry': '20251219', 'contracts': -1, 'price': 3, 'cashAmount': 300,
             'splitToStrike': 25},
        ]
        for event in rejected:
            with self.assertRaises(InvalidRequestError, msg=event):
                self.append(event)
        with self.assertRaises(InvalidRequestError):
            self.store.import_events(
                self.book_id, [{**rejected[1], 'externalRef': 'stmt-split'}],
                import_batch_id=_token(), client_token_prefix=_token(),
                **_credentials(self.store, self.book_id))
        self.assertEqual(self.store.list_events(self.book_id)['events'], [])

        plain = self.append({'kind': 'split', 'tradeDate': '2025-11-20', 'splitRatio': 2,
                             'cashAmount': 0})['event']
        self.assertIsNone(plain['splitGroup'])
        self.assertFalse(plain['splitStandardConfirmed'])
        for key in ('splitRuleRef', 'splitRounding', 'splitToStrike', 'splitToContracts',
                    'splitToConId', 'splitToLocalSymbol'):
            self.assertIn(key, plain)
            self.assertIsNone(plain[key])

    def test_a_backup_from_before_v10_still_restores(self):
        self.append({'kind': 'share_trade', 'tradeDate': '2025-11-03', 'shares': 100,
                     'price': 80, 'cashAmount': -8000})
        backup = self.store.export_backup(self.book_id)
        for row in backup['payload']['events']:
            for column in NEW_COLUMNS:
                row.pop(module._camel(column))
        encoded = json.dumps(backup['payload'], ensure_ascii=False, sort_keys=True,
                             separators=(',', ':'), allow_nan=False)
        backup['sha256'] = hashlib.sha256(encoded.encode()).hexdigest()
        plan = self.store.reset_confirmation(self.book_id)
        self.store.restore_backup(self.book_id, backup, confirmation=plan['phrase'],
                                  client_token=_token(),
                                  **_credentials(self.store, self.book_id))
        restored = self.store.list_events(self.book_id)['events']
        self.assertEqual(len(restored), 1)
        self.assertEqual(restored[0]['shares'], 100)
        self.assertIsNone(restored[0]['splitGroup'])
        self.assertFalse(restored[0]['splitStandardConfirmed'])


class MigrationV9ToV10Tests(TempStoreCase):
    V9_COLUMNS = tuple(column for column in module._EVENT_COLUMNS if column not in NEW_COLUMNS)

    def _seed(self):
        self.append({'kind': 'share_trade', 'tradeDate': '2025-11-03', 'shares': 100,
                     'price': 80, 'cashAmount': -8000,
                     'brokerTimestamp': '2025-11-03T10:00:00', 'source': 'csv_import',
                     'externalRef': 'stmt-1'})
        put = {'kind': 'option_trade', 'right': 'P', 'strike': 100, 'expiry': '20251219',
               'price': 4, 'sharesPerContract': 100}
        self.append({**put, 'tradeDate': '2025-11-04', 'contracts': -2, 'cashAmount': 800,
                     'conId': 1001})
        closing = self.append({**put, 'tradeDate': '2025-11-05', 'contracts': 1,
                               'cashAmount': -400, 'conId': 1001})['event']
        self.store.void_event(self.book_id, closing['eventId'], reason='test',
                              client_token=_token())
        self.append({'kind': 'split', 'tradeDate': '2025-11-20', 'splitRatio': 2,
                     'cashAmount': 0})

    def _downgrade_to_v9_shape(self, version=9):
        v9_sql = module._SCHEMA_STATEMENTS[2]
        self.assertEqual(v9_sql.count(V10_COLUMN_BLOCK), 1)
        v9_sql = v9_sql.replace(V10_COLUMN_BLOCK, '').replace(
            ",\n                                'option_split')", ')')
        self.assertNotIn('split_group', v9_sql)
        self.assertNotIn('option_split', v9_sql)
        columns = ', '.join(self.V9_COLUMNS)
        conn = self.raw()
        try:
            conn.execute('BEGIN IMMEDIATE')
            conn.execute('ALTER TABLE cost_basis_events RENAME TO old_events')
            conn.execute(v9_sql)
            conn.execute(f'INSERT INTO cost_basis_events ({columns}) '
                         f'SELECT {columns} FROM old_events')
            conn.execute('DROP TABLE old_events')
            for statement in module._V3_EVENT_INDEX_STATEMENTS:
                conn.execute(statement)
            conn.execute(f'PRAGMA user_version = {version}')
            conn.execute('COMMIT')
        finally:
            conn.close()

    def _v9_rows(self):
        conn = self.raw()
        try:
            return [tuple(row) for row in conn.execute(
                f"SELECT {', '.join(self.V9_COLUMNS)} FROM cost_basis_events ORDER BY seq")]
        finally:
            conn.close()

    def test_v9_rows_survive_unchanged_and_join_no_group(self):
        self._seed()
        self._downgrade_to_v9_shape()
        before = self._v9_rows()
        with self.assertRaises(StoreUnavailableError):
            CostBasisStore(self.db_path).list_books()

        migrated = CostBasisStore(self.db_path).initialize()
        self.assertEqual(self._v9_rows(), before)
        conn = self.raw()
        try:
            self.assertEqual(conn.execute('PRAGMA user_version').fetchone()[0],
                             SCHEMA_USER_VERSION)
            self.assertEqual(conn.execute(
                'SELECT count(*) FROM cost_basis_events WHERE split_group IS NOT NULL '
                'OR split_standard_confirmed <> 0').fetchone()[0], 0)
            indexes = {row['name'] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index' "
                "AND tbl_name = 'cost_basis_events' AND sql IS NOT NULL")}
            self.assertEqual(indexes, {
                'idx_cost_basis_events_external', 'idx_cost_basis_events_book_seq',
                'idx_cost_basis_events_book_date', 'idx_cost_basis_events_batch',
                'idx_cost_basis_events_split_group'})
            tables = {row['name'] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'")}
            self.assertNotIn('cost_basis_events_v9', tables)
        finally:
            conn.close()
        events = migrated.list_events(self.book_id, include_voided=True)['events']
        self.assertEqual(len(events), 4)
        self.assertEqual(sum(1 for item in events if item['voidedAtUtc']), 1)

    def test_older_migrations_run_on_a_table_without_split_columns(self):
        # v5 -> v6 replays option timelines; it must not order by a v10 column.
        self._seed()
        self._downgrade_to_v9_shape(version=5)
        before = self._v9_rows()
        CostBasisStore(self.db_path).initialize()
        self.assertEqual(self._v9_rows(), before)

    def test_a_failed_rebuild_leaves_the_v9_database_untouched(self):
        self._seed()
        self._downgrade_to_v9_shape()
        before = self._v9_rows()
        original = module._V10_EVENT_INDEX_STATEMENTS
        module._V10_EVENT_INDEX_STATEMENTS = ('CREATE INDEX broken ON missing_table(x)',)
        try:
            with self.assertRaises(StoreUnavailableError):
                CostBasisStore(self.db_path).initialize()
        finally:
            module._V10_EVENT_INDEX_STATEMENTS = original
        conn = self.raw()
        try:
            self.assertEqual(conn.execute('PRAGMA user_version').fetchone()[0], 9)
            columns = {row['name'] for row in conn.execute('PRAGMA table_info(cost_basis_events)')}
            self.assertNotIn('split_group', columns)
        finally:
            conn.close()
        self.assertEqual(self._v9_rows(), before)
        CostBasisStore(self.db_path).initialize()
        self.assertEqual(self._v9_rows(), before)


class SplitGroupWriteTests(TempStoreCase):
    OCC100 = 'TQQQ  251219P00100000'

    def header(self, **extra):
        return {'kind': 'split', 'tradeDate': '2025-11-20', 'splitRatio': 2,
                'splitRuleRef': 'OCC #57592', 'splitRounding': 'half_up_cent',
                'cashAmount': 0, **extra}

    def leg(self, strike, contracts, *, ratio=2, **extra):
        return {'kind': 'option_split', 'tradeDate': '2025-11-20', 'right': 'P',
                'strike': strike, 'expiry': '20251219', 'sharesPerContract': 100,
                'contracts': contracts, 'splitRatio': ratio,
                'splitToStrike': _split_strike_cents(_strike_cents(strike), ratio) / 100,
                'splitToContracts': -contracts * ratio, 'cashAmount': 0,
                'localSymbol': f'TQQQ 19DEC25 {strike:g} P', **extra}

    def put(self, date, strike, contracts, price, **extra):
        return {'kind': 'option_trade', 'tradeDate': date, 'right': 'P', 'strike': strike,
                'expiry': '20251219', 'contracts': contracts, 'price': price,
                'sharesPerContract': 100, 'cashAmount': round(-contracts * 100 * price, 6),
                'localSymbol': f'TQQQ 19DEC25 {strike:g} P', **extra}

    def record(self, events, token=None):
        return self.store.append_split_group(
            self.book_id, events, client_token=token or _token(),
            **_credentials(self.store, self.book_id))

    def live(self):
        return self.store.list_events(self.book_id)['events']

    def test_s3_a_recorded_group_backs_every_later_close(self):
        self.append({'kind': 'share_trade', 'tradeDate': '2025-11-03', 'shares': 100,
                     'price': 80, 'cashAmount': -8000})
        self.append(self.put('2025-11-04', 100, -2, 4, conId=1001, localSymbol=self.OCC100))
        result = self.record([self.header(), self.leg(100, 2, conId=1001,
                                                       localSymbol=self.OCC100)])
        self.assertFalse(result['idempotentReplay'])
        self.assertTrue(result['splitGroup'].startswith('split-'))
        kinds = [row['kind'] for row in result['events']]
        self.assertEqual(kinds, ['split', 'option_split'])
        self.assertEqual(result['events'][1]['splitToStrike'], 50)
        self.assertEqual(result['events'][1]['splitToContracts'], -4)
        # Post-split rows typed by hand close the adjusted contract.
        self.append(self.put('2025-11-24', 50, 1, 1, localSymbol=None, fees=1,
                             cashAmount=-101))
        self.append({'kind': 'option_assignment', 'tradeDate': '2025-12-19', 'right': 'P',
                     'strike': 50, 'expiry': '20251219', 'contracts': 1, 'shares': 100,
                     'sharesPerContract': 100, 'cashAmount': -5000})
        self.append({'kind': 'option_expiry', 'tradeDate': '2025-12-19', 'right': 'P',
                     'strike': 50, 'expiry': '20251219', 'contracts': 2,
                     'sharesPerContract': 100, 'cashAmount': 0})
        with self.assertRaises(PositionOverdrawError):
            self.append({'kind': 'option_expiry', 'tradeDate': '2025-12-19', 'right': 'P',
                         'strike': 50, 'expiry': '20251219', 'contracts': 1,
                         'sharesPerContract': 100, 'cashAmount': 0})

    def test_every_group_invariant_is_proven_before_anything_is_written(self):
        self.append(self.put('2025-11-04', 100, -2, 4))
        self.append(self.put('2025-11-05', 80, -1, 2))
        both = [self.leg(100, 2), self.leg(80, 1)]
        cases = {
            'partial conversion': [self.header(), self.leg(100, 1), both[1]],
            'series left behind': [self.header(), both[0]],
            'nothing open there': [self.header()] + both + [self.leg(60, 1)],
            'series converted twice': [self.header(), both[0], both[0], both[1]],
            'wrong adjusted strike': [self.header(), {**both[0], 'splitToStrike': 49.99}, both[1]],
            'wrong adjusted size': [self.header(), {**both[0], 'splitToContracts': -2}, both[1]],
            'non-integer ratio': [self.header(splitRatio=1.5)],
            'no rule reference': [self.header(splitRuleRef='')] + both,
            'unknown rounding': [self.header(splitRounding='nearest')] + both,
            'broker time on a split': [self.header(brokerTimestamp='2025-11-20T09:30:00')] + both,
            'cash on a split': [self.header(cashAmount=1)] + both,
            'no header': both,
            'two headers': [self.header(), self.header()] + both,
            'leg ratio differs': [self.header(), self.leg(100, 2, ratio=3), both[1]],
            'leg on another day': [self.header(), {**both[0], 'tradeDate': '2025-11-21'}, both[1]],
        }
        before = self.live()
        for name, events in cases.items():
            # A leg with nothing behind it already fails its own timeline
            # as an overdrawn close; the rest fail the group proof.
            with self.subTest(name), \
                    self.assertRaises((InvalidRequestError, PositionOverdrawError)):
                self.record(events)
        self.assertEqual(self.live(), before)
        self.record([self.header()] + both)

    def test_only_the_standard_option_class_converts(self):
        self.append(self.put('2025-11-04', 100, -2, 4, localSymbol='2TQQQ 251219P00100000'))
        with self.assertRaises(InvalidRequestError) as caught:
            self.record([self.header(), self.leg(100, 2, localSymbol=None)])
        self.assertIn('2TQQQ', str(caught.exception))

    def test_a_series_without_a_symbol_needs_explicit_confirmation(self):
        self.append(self.put('2025-11-04', 100, -2, 4, localSymbol=None))
        with self.assertRaises(InvalidRequestError):
            self.record([self.header(), self.leg(100, 2, localSymbol=None)])
        self.record([self.header(), self.leg(100, 2, localSymbol=None,
                                             splitStandardConfirmed=True)])

    def test_an_adjusted_deliverable_is_not_converted(self):
        self.append(self.put('2025-11-04', 100, -2, 4, sharesPerContract=50,
                             cashAmount=400))
        with self.assertRaises(InvalidRequestError):
            self.record([self.header(), self.leg(100, 2, sharesPerContract=50)])

    def test_a_series_that_expired_before_the_split_is_not_converted(self):
        self.append(self.put('2025-10-01', 70, -1, 1, expiry='20251031'))
        self.append(self.put('2025-11-04', 100, -2, 4))
        self.record([self.header(), self.leg(100, 2)])

    def test_one_split_per_day_and_never_beside_a_plain_split_row(self):
        plain = {'kind': 'split', 'tradeDate': '2025-11-20', 'splitRatio': 2, 'cashAmount': 0}
        plain_row = self.append(plain)['event']
        with self.assertRaises(InvalidRequestError):
            self.record([self.header()])
        self.store.void_event(self.book_id, plain_row['eventId'], reason='replaced',
                              client_token=_token())
        self.record([self.header()])
        with self.assertRaises(InvalidRequestError):
            self.record([self.header()])
        with self.assertRaises(InvalidRequestError):
            self.append(plain)
        self.append({**plain, 'tradeDate': '2025-12-01'})

    def test_a_retry_returns_the_committed_group(self):
        self.append(self.put('2025-11-04', 100, -2, 4))
        token = _token()
        credentials = _credentials(self.store, self.book_id)
        first = self.store.append_split_group(
            self.book_id, [self.header(), self.leg(100, 2)], client_token=token, **credentials)
        # A dropped reply is retried with the same plan and the same stale
        # version; it finds the committed group instead of refusing.
        again = self.store.append_split_group(
            self.book_id, [self.header(), self.leg(100, 2)], client_token=token, **credentials)
        self.assertTrue(again['idempotentReplay'])
        self.assertEqual([row['eventId'] for row in again['events']],
                         [row['eventId'] for row in first['events']])
        self.assertEqual(len(self.live()), 3)

    def test_back_dated_history_must_still_agree_with_the_split(self):
        self.append(self.put('2025-11-04', 100, -2, 4))
        self.record([self.header(), self.leg(100, 2)])
        # One more pre-split contract would leave -1 behind at the split.
        with self.assertRaises(InvalidRequestError):
            self.append(self.put('2025-11-10', 100, -1, 4))
        # A new series open across the split was never converted.
        with self.assertRaises(InvalidRequestError):
            self.append(self.put('2025-11-10', 90, -1, 3))
        with self.assertRaises(InvalidRequestError):
            self.store.import_events(
                self.book_id, [{**self.put('2025-11-10', 90, -1, 3), 'externalRef': 'stmt-1'}],
                import_batch_id=_token(), client_token_prefix=_token(),
                **_credentials(self.store, self.book_id))
        # A series that expired before the split does not involve it.
        self.append(self.put('2025-11-10', 90, -1, 1, expiry='20251114'))
        # Post-split history on the adjusted contract is ordinary history.
        self.append(self.put('2025-11-24', 50, 1, 1))

    def test_a_group_is_voided_whole_and_only_when_nothing_depends_on_it(self):
        self.append(self.put('2025-11-04', 100, -2, 4))
        group = self.record([self.header(), self.leg(100, 2)])
        leg = group['events'][1]
        with self.assertRaises(InvalidRequestError):
            self.store.void_event(self.book_id, leg['eventId'], reason='x',
                                  client_token=_token())
        expiry = self.append({'kind': 'option_expiry', 'tradeDate': '2025-12-19',
                              'right': 'P', 'strike': 50, 'expiry': '20251219',
                              'contracts': 4, 'sharesPerContract': 100,
                              'cashAmount': 0})['event']
        with self.assertRaises(PositionOverdrawError):
            self.store.void_split_group(self.book_id, group['splitGroup'], reason='mistake',
                                        client_token=_token())
        self.store.void_event(self.book_id, expiry['eventId'], reason='first',
                              client_token=_token())
        token = _token()
        voided = self.store.void_split_group(self.book_id, group['splitGroup'],
                                             reason='mistake', client_token=token)
        self.assertTrue(all(row['voidedAtUtc'] for row in voided['events']))
        self.assertEqual(len(voided['events']), 2)
        self.assertTrue(self.store.void_split_group(
            self.book_id, group['splitGroup'], reason='mistake',
            client_token=token)['idempotentReplay'])
        with self.assertRaises(EventAlreadyVoidedError):
            self.store.void_split_group(self.book_id, group['splitGroup'], reason='again',
                                        client_token=_token())
        # The pre-split position stands again.
        self.append({'kind': 'option_expiry', 'tradeDate': '2025-12-19', 'right': 'P',
                     'strike': 100, 'expiry': '20251219', 'contracts': 2,
                     'sharesPerContract': 100, 'cashAmount': 0})

    def test_statement_and_single_row_paths_refuse_group_rows(self):
        self.append(self.put('2025-11-04', 100, -2, 4))
        for rows in ([self.header()], [self.leg(100, 2, splitGroup='g')]):
            with self.subTest(rows[0]['kind']), self.assertRaises(InvalidRequestError):
                self.store.import_events(
                    self.book_id, [{**row, 'externalRef': f'stmt-{index}'}
                                   for index, row in enumerate(rows)],
                    import_batch_id=_token(), client_token_prefix=_token(),
                    **_credentials(self.store, self.book_id))
        with self.assertRaises(InvalidRequestError):
            self.append(self.leg(100, 2, splitGroup='g'))
        plan = self.store.reset_confirmation(self.book_id)
        with self.assertRaises(InvalidRequestError):
            self.store.rebuild_book(
                self.book_id, [self.header(splitGroup='g')], confirmation=plan['phrase'],
                client_token=_token(), import_batch_id=_token(),
                **_credentials(self.store, self.book_id))

    def test_a_backup_restores_a_group_but_not_a_tampered_one(self):
        self.append(self.put('2025-11-04', 100, -2, 4))
        self.record([self.header(), self.leg(100, 2)])
        backup = self.store.export_backup(self.book_id)
        plan = self.store.reset_confirmation(self.book_id)
        self.store.restore_backup(self.book_id, backup, confirmation=plan['phrase'],
                                  client_token=_token(),
                                  **_credentials(self.store, self.book_id))
        restored = self.store.list_events(self.book_id, include_voided=True)['events']
        self.assertEqual(restored, backup['payload']['events'])

        tampered = json.loads(json.dumps(backup))
        leg = next(row for row in tampered['payload']['events'] if row['kind'] == 'option_split')
        leg['contracts'], leg['splitToContracts'] = 1.0, -2.0
        encoded = json.dumps(tampered['payload'], ensure_ascii=False, sort_keys=True,
                             separators=(',', ':'), allow_nan=False)
        tampered['sha256'] = hashlib.sha256(encoded.encode()).hexdigest()
        plan = self.store.reset_confirmation(self.book_id)
        with self.assertRaises(InvalidRequestError):
            self.store.restore_backup(self.book_id, tampered, confirmation=plan['phrase'],
                                      client_token=_token(),
                                      **_credentials(self.store, self.book_id))
        self.assertEqual(self.store.list_events(self.book_id, include_voided=True)['events'],
                         restored)

    def test_a_tws_reconciliation_after_a_split_counts_the_converted_position(self):
        self.append(self.put('2025-11-04', 100, -1, 4))
        self.record([self.header(), self.leg(100, 1)])
        fill = {**self.put('2025-11-24', 50, -1, 1, localSymbol=None, conId=5050),
                'source': 'execution_report', 'tag': 'ibkr_exec',
                'externalRef': 'ibkr-exec-post-split', 'brokerTimestamp': '2025-11-24T10:00:00'}
        proof = {'kind': 'option', 'account': ACCOUNT, 'right': 'P', 'strike': 50,
                 'expiry': '20251219', 'sharesPerContract': 100, 'conId': 5050,
                 'ledgerContracts': -2, 'twsContracts': -3}
        result = self.store.import_events(
            self.book_id, [fill], import_batch_id=_token(), client_token_prefix=_token(),
            supersede_tws_event_ids=[], tws_reconciliation=[proof],
            **_credentials(self.store, self.book_id))
        self.assertEqual(result['inserted'], 1)

    def test_a_stale_preview_cannot_record_a_split(self):
        """A14: another tab wrote after this preview was drawn."""
        self.append(self.put('2025-11-04', 100, -2, 4))
        seen = _credentials(self.store, self.book_id)
        self.append(self.put('2025-11-05', 100, 1, 3))
        with self.assertRaises(module.LedgerChangedError):
            self.store.append_split_group(self.book_id, [self.header(), self.leg(100, 1)],
                                          client_token=_token(), **seen)
        self.record([self.header(), self.leg(100, 1)])

    def test_voiding_a_converted_opening_is_refused_until_the_group_is_redone(self):
        """A07: the group proves what was open; history under it cannot move."""
        opening = self.append(self.put('2025-11-04', 100, -2, 4))['event']
        group = self.record([self.header(), self.leg(100, 2)])
        with self.assertRaises((InvalidRequestError, PositionOverdrawError)):
            self.store.void_event(self.book_id, opening['eventId'], reason='wrong',
                                  client_token=_token())
        # The complete repair: void the group, fix the history, record again.
        self.store.void_split_group(self.book_id, group['splitGroup'], reason='redo',
                                    client_token=_token())
        self.store.void_event(self.book_id, opening['eventId'], reason='wrong',
                              client_token=_token())
        self.append(self.put('2025-11-04', 100, -3, 4))
        self.record([self.header(), self.leg(100, 3)])
        live = [row for row in self.live() if row['kind'] == 'option_split']
        self.assertEqual([(row['contracts'], row['splitToContracts']) for row in live],
                         [(3.0, -6.0)])

    def test_a_reset_archive_with_a_group_restores_and_is_proven(self):
        """A16: clearing a book and restoring its archive keeps the group whole."""
        self.append(self.put('2025-11-04', 100, -2, 4))
        self.record([self.header(), self.leg(100, 2)])
        before = self.store.list_events(self.book_id, include_voided=True)['events']
        plan = self.store.reset_confirmation(self.book_id)
        reset = self.store.reset_book(self.book_id, confirmation=plan['phrase'],
                                      client_token=_token(),
                                      **_credentials(self.store, self.book_id))
        self.assertEqual(self.live(), [])
        plan = self.store.reset_confirmation(self.book_id)
        self.store.restore_book_reset(self.book_id, reset['resetId'],
                                      confirmation=plan['phrase'], client_token=_token(),
                                      **_credentials(self.store, self.book_id))
        self.assertEqual(self.store.list_events(self.book_id, include_voided=True)['events'],
                         before)
        self.append({'kind': 'option_expiry', 'tradeDate': '2025-12-19', 'right': 'P',
                     'strike': 50, 'expiry': '20251219', 'contracts': 4,
                     'sharesPerContract': 100, 'cashAmount': 0})

    def test_conid_kept_or_changed_by_the_broker_both_resolve(self):
        """Whether IBKR keeps a contract number through the adjustment is
        unknown, so both cases must work: here the old K100 keeps 1001 as the
        new K50 while the old K50 (2002) becomes K25 with its number."""
        occ = 'TQQQ  251219P{:08d}'
        self.append(self.put('2025-11-04', 100, -1, 4, conId=1001,
                             localSymbol=occ.format(100000)))
        self.append(self.put('2025-11-05', 50, -1, 1, conId=2002,
                             localSymbol=occ.format(50000)))
        self.record([self.header(),
                     self.leg(100, 1, conId=1001, localSymbol=occ.format(100000),
                              splitToConId=1001, splitToLocalSymbol=occ.format(50000)),
                     self.leg(50, 1, conId=2002, localSymbol=occ.format(50000),
                              splitToConId=2002, splitToLocalSymbol=occ.format(25000))])
        # Post-split TWS fills carry the kept numbers; a hand-typed close has none.
        self.append(self.put('2025-11-24', 50, 1, 0.5, conId=1001,
                             localSymbol=occ.format(50000)))
        self.append(self.put('2025-11-25', 25, 1, 0.2, conId=2002,
                             localSymbol=occ.format(25000)))
        self.append({'kind': 'option_expiry', 'tradeDate': '2025-12-19', 'right': 'P',
                     'strike': 50, 'expiry': '20251219', 'contracts': 1,
                     'sharesPerContract': 100, 'cashAmount': 0})
        self.append({'kind': 'option_expiry', 'tradeDate': '2025-12-19', 'right': 'P',
                     'strike': 25, 'expiry': '20251219', 'contracts': 1,
                     'sharesPerContract': 100, 'cashAmount': 0})
        with self.assertRaises(PositionOverdrawError):
            self.append({'kind': 'option_expiry', 'tradeDate': '2025-12-19', 'right': 'P',
                         'strike': 50, 'expiry': '20251219', 'contracts': 1,
                         'sharesPerContract': 100, 'cashAmount': 0})

    def test_two_series_landing_on_one_adjusted_contract_are_refused(self):
        """99.97 and 99.98 both become 49.99 at 2:1; merging them would net
        two different contracts, so the group cannot be recorded."""
        self.append(self.put('2025-11-04', 99.97, -1, 1))
        self.append(self.put('2025-11-05', 99.98, -1, 1))
        with self.assertRaises(InvalidRequestError) as caught:
            self.record([self.header(), self.leg(99.97, 1), self.leg(99.98, 1)])
        self.assertIn('two series', str(caught.exception))

    def test_the_browser_plan_is_what_the_store_accepts(self):
        """The core's planSplitGroup draft, recorded as-is, then replayed."""
        self.append({'kind': 'share_trade', 'tradeDate': '2025-11-03', 'shares': 100,
                     'price': 80, 'cashAmount': -8000})
        self.append(self.put('2025-11-04', 100, -2, 4, conId=1001, localSymbol=self.OCC100))
        self.append(self.put('2025-11-05', 99.97, -1, 1, localSymbol=None))
        self.append(self.put('2025-11-06', 50, 1, 0.5))
        script = r"""
const { loadBrowserScripts } = require('./tests/helpers/load-browser-scripts');
const core = loadBrowserScripts(['js/cost_basis_core.js']).OptionComboCostBasisCore;
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = input.mode === 'plan'
    ? core.planSplitGroup(input.events, input.options)
    : core.computeLedger(input.events, {});
process.stdout.write(JSON.stringify(input.mode === 'plan' ? out
    : { openOptions: out.openOptions, perAccount: out.perAccount }));
"""
        def node(payload):
            done = subprocess.run(['node', '-e', script], input=json.dumps(payload), cwd=ROOT,
                                  capture_output=True, text=True, check=True)
            return json.loads(done.stdout)
        plan = node({'mode': 'plan', 'events': self.live(), 'options': {
            'account': ACCOUNT, 'tradeDate': '2025-11-20', 'ratio': 2,
            'ruleRef': 'OCC #57592', 'underlying': 'TQQQ'}})
        self.assertEqual(plan['problems'], [])
        self.assertEqual(sorted(leg['splitToStrike'] for leg in plan['legs']), [25, 49.99, 50])
        legs = [{**leg, 'splitStandardConfirmed': leg['needsStandardConfirmation']}
                for leg in plan['legs']]
        self.record([plan['header']] + legs)
        replay = node({'mode': 'replay', 'events': self.live()})
        account = replay['perAccount'][ACCOUNT]
        self.assertEqual(account['warnings'], [])
        self.assertEqual(account['shares'], 200)
        positions = sorted((item['strike'], item['contracts'], item['openPremium'])
                           for item in replay['openOptions'])
        self.assertEqual(positions, [(25, 2, -50), (49.99, -2, 100), (50, -4, 800)])


if __name__ == '__main__':
    unittest.main()

