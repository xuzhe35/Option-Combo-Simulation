"""Opt-in actual masked report -> page -> temporary store, never a live ledger."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from cost_basis_store import CostBasisStore


@unittest.skipUnless(os.environ.get('COST_BASIS_MASKED_STATEMENT_CSV'),
                     'set COST_BASIS_MASKED_STATEMENT_CSV for the local report regression')
class MaskedStatementStoreTests(unittest.TestCase):
    def test_actual_daily_append_and_repeat_preserve_cash_and_all_contracts(self):
        fixture = json.loads(subprocess.check_output(
            ['node', str(ROOT / 'tests/cost_basis_masked_account.test.js')], cwd=ROOT, text=True))

        def clean(event):
            return {key: value for key, value in event.items() if key not in (
                'eventId', 'seq', 'sourceRef', 'sourceLegs', 'lineNumber', 'currency',
                'cashDerived', 'unpaired', 'fills', 'fillOf', 'priceText')}

        with tempfile.TemporaryDirectory() as temp:
            store = CostBasisStore(pathlib.Path(temp) / 'masked-report.db').initialize()
            book = store.create_book(account=fixture['baseline']['account'], symbol='TQQQ', start_date='2026-09-10')
            bid = book['bookId']
            store.append_event(bid, clean(fixture['baseline']), client_token='baseline-test')
            incoming = [clean(row) for row in fixture['incoming']]
            params = dict(import_batch_id='daily-test', client_token_prefix='daily-test',
                          expected_ledger_version=store.ledger_version(bid), book_identity=book)
            result = store.import_events(bid, incoming, **params)
            # Every expectation comes from the local report itself; the
            # repository keeps no quantity from any real statement.
            self.assertEqual(result['inserted'], len(incoming))
            self.assertEqual(result['warnings'], [])
            rows = store.list_events(bid, limit=1000)['events']
            self.assertEqual(len(rows), len(incoming) + 1)
            self.assertEqual(sum(row.get('shares') or 0 for row in rows), fixture['expectedShares'])
            self.assertAlmostEqual(sum(row['cashAmount'] for row in rows), fixture['expectedCash'], places=5)
            options = {}
            for row in rows:
                if row.get('contracts') is not None:
                    key = (row['right'], float(row['strike']), str(row['expiry']).replace('-', ''))
                    options[key] = options.get(key, 0) + row['contracts']
            expected = {}
            for item in fixture['expectedOptions']:
                key = (item['right'], float(item['strike']), item['expiry'])
                expected[key] = expected.get(key, 0) + item['contracts']
            self.assertEqual({key: quantity for key, quantity in options.items() if abs(quantity) > 1e-9},
                             {key: quantity for key, quantity in expected.items() if abs(quantity) > 1e-9})
            retry = store.import_events(bid, incoming, **params)
            self.assertTrue(retry['idempotentReplay'])
            repeated = store.import_events(bid, incoming, import_batch_id='daily-again',
                client_token_prefix='daily-again', expected_ledger_version=store.ledger_version(bid), book_identity=book)
            self.assertEqual(repeated['inserted'], 0)
            self.assertEqual(repeated['skipped'], len(incoming))
            self.assertEqual(store.list_events(bid)['total'], len(incoming) + 1)

if __name__ == '__main__':
    unittest.main()
