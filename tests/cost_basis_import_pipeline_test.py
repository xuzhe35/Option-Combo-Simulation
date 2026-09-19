"""Actual page -> actual store regression tests. No real DB, browser or broker."""
import hashlib
import json
import pathlib
import subprocess
import tempfile
import unittest
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from cost_basis_store import (CostBasisStore, InvalidRequestError, LedgerChangedError,
                              ResetConfirmationError, ImportRevisionConflictError, PositionOverdrawError)
ROOT = pathlib.Path(__file__).resolve().parents[1]

class ImportPipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = json.loads(subprocess.check_output(
            ['node', str(ROOT/'tests/cost_basis_import_pipeline.test.js')], cwd=ROOT, text=True))

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = CostBasisStore(pathlib.Path(self.tmp.name)/'test.db').initialize()
        self.book = self.store.create_book(account='U1111111', symbol='TQQQ', start_date='2026-01-01')
        self.bid = self.book['bookId']
        self.counter = 0

    def token(self):
        self.counter += 1
        return f'pipeline-token-{self.counter}'

    def credentials(self):
        return dict(expected_ledger_version=self.store.ledger_version(self.bid), book_identity=self.book)

    def import_rows(self, rows, **kwargs):
        return self.store.import_events(self.bid, rows, import_batch_id=self.token(),
            client_token_prefix=self.token(), **(self.credentials() | kwargs))

    @staticmethod
    def event(e):
        return {k:v for k,v in e.items() if k not in ('eventId','seq','sourceRef','sourceLegs',
            'fills','fillOf','priceText','lineNumber','currency','cashDerived','unpaired')}

    @staticmethod
    def statement(month):
        return dict(format='activity', account='U1111111', periodFrom=f'2026-{month:02}-01',
            periodThrough=f'2026-{month:02}-{31 if month==8 else 30}',
            checks=dict(period=True,account=True,openPositions=True,revision=True,twsCoverage=True))

    def test_page_payloads_reach_the_correct_final_ledger(self):
        cases = {
            'FIXED_IDENTICAL_TWS': (20,0,-1002), 'FIXED_CASH_SIGNS': (0,0,-7),
            'FLEX_PRIOR_STUB': (0,-1,200), 'FIXED_ACTIVITY_STUB': (0,-1,200),
            'NET_PRIOR_HISTORY': (0,-1,300), 'NO_TRADE_INITIAL_HOLDING': (100,0,-5000),
            'VALID_PARTIAL_FILLS': (20,0,-1002), 'UNCHANGED_SAME_REF': (10,0,-501),
            'UNCHANGED_DIRECT_EXEC': (10,0,-501),
            'APPEND_SAME_TIME_CLOSE': (0,0,102.938067),
            'APPEND_DISTINCT_SAME_SECOND': (0,1,0),
            'CASH_SAME_DAY_ADDITION': (0,0,-2),
            'MIXED_REVERSAL_FRESH': (0,-2,224.833482),
            'MIXED_REVERSAL_APPEND': (0,-2,224.833482),
            'MIXED_REVERSAL_REPEAT': (0,-2,224.833482),
        }
        for name, expected in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as root:
                store = CostBasisStore(pathlib.Path(root)/'ledger.db').initialize()
                book = store.create_book(account='U1111111',symbol='TQQQ',start_date='2026-01-01')
                bid = book['bookId']; fixture=self.fixtures[name]; ids={}
                self.assertFalse(fixture['problems'])
                for old in fixture['existing']:
                    stored=store.append_event(bid,self.event(old),client_token=self.token())
                    ids[old['eventId']]=stored['event']['eventId']
                events=[self.event(row) for row in fixture['incoming']]
                store.import_events(bid,events,import_batch_id=self.token(),client_token_prefix=self.token(),
                    expected_ledger_version=store.ledger_version(bid),book_identity=book,
                    supersede_prior_stub_event_ids=[ids[i] for i in fixture['supersedePriorStubEventIds']],
                    statement=self.statement(9))
                rows=store.list_events(bid)['events']
                actual=tuple(sum(row.get(field) or 0 for row in rows) for field in ('shares','contracts','cashAmount'))
                self.assertEqual(actual,expected)

    def test_rebuild_page_payload_retains_known_openings_and_round_trips_archive(self):
        for name in ('REBUILD_KNOWN_OPEN', 'REBUILD_ALL_KNOWN', 'MIXED_REVERSAL_REBUILD'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as root:
                store = CostBasisStore(pathlib.Path(root)/'ledger.db').initialize()
                book = store.create_book(account='U1111111', symbol='TQQQ', start_date='2026-01-01')
                bid = book['bookId']
                fixture = self.fixtures[name]
                self.assertFalse(fixture['problems'])
                for old in fixture['existing']:
                    store.append_event(bid, self.event(old), client_token=self.token())
                plan = store.reset_confirmation(bid)
                rebuilt = store.rebuild_book(bid, [self.event(e) for e in fixture['incoming']],
                    confirmation=plan['phrase'], client_token=self.token(), import_batch_id=self.token(),
                    expected_ledger_version=plan['ledgerVersion'], book_identity=book,
                    statement=self.statement(9))
                rows = store.list_events(bid)['events']
                self.assertEqual(len(rows), 2)
                mixed = name == 'MIXED_REVERSAL_REBUILD'
                self.assertEqual(sum(row['contracts'] for row in rows), -2 if mixed else 0)
                self.assertAlmostEqual(sum(row['cashAmount'] for row in rows),
                                       224.833482 if mixed else 102.938067)
                fresh = store.reset_confirmation(bid)
                store.restore_book_reset(bid, rebuilt['resetId'], confirmation=fresh['phrase'],
                    client_token=self.token(), expected_ledger_version=fresh['ledgerVersion'], book_identity=book)
                self.assertEqual(store.list_events(bid)['total'], len(fixture['existing']))

    def test_mixed_reversal_failure_rolls_back_entire_rebuild(self):
        self.import_rows([self.event(self.fixtures['UNCHANGED_SAME_REF']['existing'][0])])
        original = self.store.list_events(self.bid)['events']
        rows = [self.event(e) for e in self.fixtures['MIXED_REVERSAL_REBUILD']['incoming']]
        for invalid in ([rows[1]], [rows[0], {**rows[1], 'tag': 'ibkr_close'}]):
            plan = self.store.reset_confirmation(self.bid)
            with self.assertRaises(PositionOverdrawError):
                self.store.rebuild_book(self.bid, invalid,
                    confirmation=plan['phrase'], client_token=self.token(), import_batch_id=self.token(),
                    expected_ledger_version=plan['ledgerVersion'], book_identity=self.book)
            self.assertEqual(self.store.ledger_version(self.bid), plan['ledgerVersion'])
            self.assertEqual(self.store.list_events(self.bid)['events'], original)

    def test_all_blocked_previews_leave_no_write_payload_authorized(self):
        for name in ('SAME_REF_REVISION','DIRECT_EXEC_REVISION','REUSED_CROSS_FORMAT_TWIN',
                     'QUANTITY_REVISION','DATE_ONLY_TWIN','ORDER_FILL_CASH_MISMATCH',
                     'BAD_POSITION_SYMBOL','ZERO_TRADE_TWS_ROUNDTRIP','MANUAL_ASSIGNMENT_TWIN','MISSING_CURRENCY'):
            self.assertTrue(self.fixtures[name]['problems'],name)

    def test_optional_full_statement_rebuild_and_repeated_import(self):
        fixture = self.fixtures.get('FULL_STATEMENT_REBUILD')
        if fixture is None:
            self.skipTest('set COST_BASIS_FULL_STATEMENT_CSV to verify a local complete statement')
        book = self.store.create_book(account=fixture['book']['account'], symbol='TQQQ', start_date='2026-01-01')
        bid = book['bookId']
        old = [self.event(row) for row in fixture['existing']]
        # The pre-existing partial ledger is only the overlap input. A rebuild
        # must not depend on its missing earlier opening balances.
        old = [row for row in old if row['kind'] == 'option_trade' and row.get('tag') == 'ibkr_open']
        self.store.import_events(bid, old, import_batch_id=self.token(), client_token_prefix=self.token(),
            expected_ledger_version=self.store.ledger_version(bid), book_identity=book)
        plan = self.store.reset_confirmation(bid)
        incoming = [self.event(row) for row in fixture['incoming']]
        params = dict(confirmation=plan['phrase'], client_token=self.token(), import_batch_id=self.token(),
            expected_ledger_version=plan['ledgerVersion'], book_identity=book)
        rebuilt = self.store.rebuild_book(bid, incoming, **params)
        self.assertEqual(rebuilt['inserted'], len(incoming))
        self.assertEqual(rebuilt['warnings'], [])
        rows = self.store.list_events(bid, limit=1000)['events']
        self.assertAlmostEqual(sum(row.get('shares') or 0 for row in rows), fixture['expected']['shares'])
        self.assertAlmostEqual(sum(row['cashAmount'] for row in rows), fixture['expected']['netCash'], places=5)
        # Read the persisted rows back through the browser engine. This catches
        # dropped tags/identities and validates every remaining contract, not
        # just the aggregate number (which can hide offsetting mistakes).
        script = """
const {loadBrowserScripts}=require('./tests/helpers/load-browser-scripts');
const core=loadBrowserScripts(['js/cost_basis_core.js']).OptionComboCostBasisCore;
const rows=JSON.parse(require('fs').readFileSync(0,'utf8'));
const ledger=core.computeLedger(rows);
console.log(JSON.stringify({warnings:ledger.warnings,positions:ledger.openOptions}));
"""
        replayed = json.loads(subprocess.check_output(['node', '-e', script], cwd=ROOT,
                                                     input=json.dumps(rows), text=True))
        self.assertEqual(replayed['warnings'], [])
        def position_key(row):
            return tuple(row.get(key) for key in ('account', 'right', 'strike', 'expiry',
                                                  'sharesPerContract')) + (str(row.get('conId') or ''),)
        self.assertEqual({position_key(row): row['contracts'] for row in replayed['positions']},
                         {position_key(row): row['quantity'] for row in fixture['expected']['closingOptions']})
        replay = self.store.rebuild_book(bid, incoming, **params)
        self.assertTrue(replay['idempotentReplay'])
        appended = self.store.import_events(bid, incoming, import_batch_id=self.token(), client_token_prefix=self.token(),
            expected_ledger_version=self.store.ledger_version(bid), book_identity=book)
        self.assertEqual(appended['inserted'], 0)
        self.assertEqual(appended['skipped'], len(incoming))
        self.assertEqual(self.store.list_events(bid)['total'], len(incoming))

    def test_missing_identity_and_version_cannot_use_store_write_paths(self):
        row=self.event(self.fixtures['UNCHANGED_SAME_REF']['existing'][0])
        plan=self.store.reset_confirmation(self.bid)
        for credentials in ({}, {'book_identity':self.book},
                            {'expected_ledger_version':plan['ledgerVersion']},
                            {'expected_ledger_version':plan['ledgerVersion'],'book_identity':{'account':self.book['account']}}):
            with self.subTest(credentials=credentials):
                with self.assertRaises(InvalidRequestError):
                    self.store.import_events(self.bid,[row],import_batch_id=self.token(),client_token_prefix=self.token(),**credentials)
                with self.assertRaises(InvalidRequestError):
                    self.store.rebuild_book(self.bid,[row],confirmation=plan['phrase'],client_token=self.token(),import_batch_id=self.token(),**credentials)
                with self.assertRaises(InvalidRequestError):
                    self.store.reset_book(self.bid,confirmation=plan['phrase'],client_token=self.token(),**credentials)
        self.assertEqual(self.store.list_events(self.bid)['total'],0)

    def test_rebuild_restore_coverage_and_checksums_follow_the_active_history(self):
        old=self.event(self.fixtures['UNCHANGED_SAME_REF']['existing'][0])
        self.import_rows([old],statement=self.statement(8))
        plan=self.store.reset_confirmation(self.bid)
        replacement={**old,'externalRef':'september','price':51,'cashAmount':-511}
        rebuilt=self.store.rebuild_book(self.bid,[replacement],confirmation=plan['phrase'],client_token=self.token(),
            import_batch_id=self.token(),statement=self.statement(9),**self.credentials())
        self.assertEqual([x['periodFrom'] for x in self.store.list_import_batches(self.bid)],['2026-09-01'])
        with self.assertRaises(ResetConfirmationError):
            self.store.rebuild_book(self.bid,[old],confirmation=plan['phrase'],client_token=self.token(),
                import_batch_id=self.token(),expected_ledger_version=plan['ledgerVersion'],book_identity=self.book)
        fresh=self.store.reset_confirmation(self.bid)
        self.store.restore_book_reset(self.bid,rebuilt['resetId'],confirmation=fresh['phrase'],client_token=self.token(),**self.credentials())
        self.assertEqual([x['periodFrom'] for x in self.store.list_import_batches(self.bid)],['2026-08-01'])
        self.assertEqual(self.store.list_events(self.bid)['events'][0]['cashAmount'],-501)
        # A void invalidates coverage without erasing the audit registration.
        event=self.store.list_events(self.bid)['events'][0]
        self.store.void_event(self.bid,event['eventId'],reason='correction',client_token=self.token())
        # Fixture is Sept 1: August evidence is correctly unaffected here.
        self.assertTrue(self.store.list_import_batches(self.bid)[0]['checks'])
        with self.store._connect() as conn:
            conn.execute("UPDATE cost_basis_book_resets SET events_json = '[]' WHERE reset_id = ?",(rebuilt['resetId'],))
        before=self.store.ledger_version(self.bid)
        with self.assertRaises(InvalidRequestError):
            self.store.restore_book_reset(self.bid,rebuilt['resetId'],confirmation=fresh['phrase'],client_token=self.token(),**self.credentials())
        self.assertEqual(before,self.store.ledger_version(self.bid))

    def test_backup_file_round_trip_preserves_voids_and_rejects_tampering(self):
        row=self.event(self.fixtures['UNCHANGED_SAME_REF']['existing'][0])
        self.import_rows([row])
        event=self.store.list_events(self.bid)['events'][0]
        self.store.void_event(self.bid,event['eventId'],reason='mistake',client_token=self.token())
        backup=self.store.export_backup(self.bid)
        plan=self.store.reset_confirmation(self.bid)
        self.store.rebuild_book(self.bid,[{**row,'externalRef':'replacement'}],confirmation=plan['phrase'],
            client_token=self.token(),import_batch_id=self.token(),**self.credentials())
        plan=self.store.reset_confirmation(self.bid)
        changed=json.loads(json.dumps(backup));changed['payload']['events'][0]['cashAmount']=-999
        with self.assertRaises(InvalidRequestError):
            self.store.restore_backup(self.bid,changed,confirmation=plan['phrase'],client_token=self.token(),**self.credentials())
        self.store.restore_backup(self.bid,backup,confirmation=plan['phrase'],client_token=self.token(),**self.credentials())
        restored=self.store.list_events(self.bid,include_voided=True)['events']
        self.assertEqual(restored,backup['payload']['events'])
        self.assertEqual(self.store.list_import_batches(self.bid),[])

    def test_v8_migration_preserves_events_but_invalidates_unproven_coverage(self):
        row=self.event(self.fixtures['UNCHANGED_SAME_REF']['existing'][0])
        self.import_rows([row],statement=self.statement(9))
        before=self.store.list_events(self.bid,include_voided=True)['events']
        with self.store._connect() as conn:
            conn.execute('DROP TABLE cost_basis_reset_coverage')
            conn.execute('PRAGMA user_version = 8')
        self.store.initialize()
        self.assertEqual(before,self.store.list_events(self.bid,include_voided=True)['events'])
        self.assertIs(self.store.list_import_batches(self.bid)[0]['checks']['coverageCurrent'],False)

    def test_void_and_backdated_import_invalidate_previously_checked_months(self):
        row=self.event(self.fixtures['UNCHANGED_SAME_REF']['existing'][0])
        self.import_rows([row],statement=self.statement(9))
        event=self.store.list_events(self.bid)['events'][0]
        self.store.void_event(self.bid,event['eventId'],reason='wrong',client_token=self.token())
        self.assertIs(self.store.list_import_batches(self.bid)[0]['checks']['coverageCurrent'],False)
        # A same-reference replay of a voided event must not silently skip.
        with self.assertRaises(ImportRevisionConflictError):
            self.import_rows([row])

    def test_every_same_reference_economic_revision_is_rejected_atomically(self):
        row=self.event(self.fixtures['UNCHANGED_SAME_REF']['existing'][0])
        self.import_rows([row])
        for change in ({'shares':20,'cashAmount':-1001},{'price':51,'cashAmount':-511},
                       {'fees':2,'cashAmount':-502}):
            with self.subTest(change=change), self.assertRaises(ImportRevisionConflictError):
                self.import_rows([{**row,**change}])
        self.assertEqual(self.store.list_events(self.bid)['total'],1)
