"""Split-group foundations in the store (A1 phase 1).

See CODE PLAN/COST_BASIS_CORPORATE_ACTIONS_PLAN.md §15. Schema v10 can hold
split groups but no write path accepts them yet; the ordering, strike and
identity helpers are shared with the browser core and checked against the
same fixtures. Every database here is a temporary file.
"""

import hashlib
import json
import pathlib
import sqlite3
import tempfile
import unittest
import uuid

import cost_basis_store as module
from cost_basis_store import (
    SCHEMA_USER_VERSION,
    CostBasisStore,
    InvalidRequestError,
    StoreUnavailableError,
    _EVENT_ORDER_SQL,
    _option_movements,
    _option_root,
    _resolve_contract_identity_rows,
    _split_strike_cents,
    _strike_cents,
)

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

    def test_no_write_path_accepts_a_split_group_yet(self):
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


if __name__ == '__main__':
    unittest.main()
