"""Seeded model-based testing of standard splits across core, planner and SQLite.

tests/helpers/cost_basis_split_model.py generates each history and predicts
its result without importing production code. For every seed:

- the browser core replays the rows (groups included) and must match the
  model's shares, cash, realized and open premium, and every open series;
- the core's planSplitGroup, given the rows before each split, must draft
  exactly the conversions the model derived;
- on store seeds the history is written row by row into a temporary SQLite
  ledger, each split through append_split_group after three corrupted
  variants of it were refused without changing the ledger; the stored rows
  must replay to the model, survive a backup round trip, and a group voided
  and recorded again must give the same result.

Normal unittest runs 100 seeds, 20 of them through SQLite. The acceptance
campaign runs more, for example:

    PYTHONPATH=. python tests/cost_basis_split_campaign_test.py --seeds 500 --start 1000 --store-every 5

A failure names the seed, the stage and the rerun command.
"""
import argparse
import copy
import json
import pathlib
import sys
import tempfile
import unittest
from collections import Counter
from fractions import Fraction as F

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'tests'))
sys.path.insert(0, str(ROOT / 'tests/helpers'))
from cost_basis_split_model import ACCOUNT, generate  # noqa: E402
from cost_basis_randomized_test import Bridge  # noqa: E402
from cost_basis_store import (  # noqa: E402
    CostBasisStore, InvalidRequestError, PositionOverdrawError)

# Branches every campaign must reach at least once, or it proves nothing.
REQUIRED = ('first_ratio_2', 'first_ratio_3', 'second_ratio_2', 'second_ratio_3',
            'long_put', 'short_put', 'long_call', 'short_call', 'pre_close', 'post_close',
            'second_close', 'post_assignment', 'expiry_recorded', 'expired_unrecorded',
            'rounded_strike', 'confirmed_without_symbol', 'split_with_options',
            'split_shares_only', 'store_seeds', 'store_refused_drop', 'store_refused_partial',
            'store_refused_strike', 'store_void_and_redo', 'store_backup_round_trip')


def _close(actual, expected):
    return abs(float(actual) - float(expected)) <= 1e-6


def check(actual, expected, label):
    combined = actual['combined']
    for field, key in (('shares', 'shares'), ('netCash', 'cash'),
                       ('realizedPremium', 'realized'), ('openPremium', 'open_premium')):
        assert _close(combined.get(field, 0), expected[key]), (label, field, combined.get(field),
                                                                float(expected[key]))
    positions = sorted((option['right'], round(option['strike'] * 100), option['expiry'],
                        round(option['contracts'], 6), round(option['openPremium'], 4))
                       for option in actual['options'])
    wanted = sorted((right, cents, expiry, round(float(contracts), 6), round(float(premium), 4))
                    for right, cents, expiry, contracts, premium in expected['positions'])
    assert positions == wanted, (label, 'positions', positions, wanted)
    allowed = ('net_short_shares',)
    assert all(warning.startswith(allowed) for warning in actual['warnings']), (
        label, 'warnings', actual['warnings'])


class SplitCampaign:
    def __init__(self):
        self.bridge = Bridge()
        self.coverage = Counter()

    def close(self):
        self.bridge.close()

    def rows(self, case):
        rows, seq = [], 0
        for number, item in enumerate(case['items']):
            group = [item[1]] + item[2] if isinstance(item, tuple) else [item]
            for row in group:
                seq += 1
                extra = {'seq': seq, 'eventId': f'e{seq}', 'includeInCost': True}
                if isinstance(item, tuple):
                    extra['splitGroup'] = f'split-model-{number}'
                rows.append({**row, **extra})
        return rows

    def verify(self, seed, store=False):
        case = generate(seed)
        self.coverage.update(case['coverage'])
        rows = self.rows(case)
        check(self.bridge.call(op='replay', rows=rows), case['model'], (seed, 'core'))
        # The planner, from the rows before each split, drafts what the model derived.
        for index, item in enumerate(case['items']):
            if not isinstance(item, tuple):
                continue
            header, legs = item[1], item[2]
            before = [row for row in rows if row['tradeDate'] < header['tradeDate']]
            plan = self.bridge.call(op='plan', rows=before, options={
                'account': ACCOUNT, 'tradeDate': header['tradeDate'], 'ratio': header['splitRatio'],
                'ruleRef': header['splitRuleRef'], 'underlying': 'TQQQ'})
            assert plan['problems'] == [], (seed, 'plan problems', plan['problems'])
            drafted = sorted((leg['right'], round(leg['strike'] * 100), leg['expiry'],
                              leg['contracts'], round(leg['splitToStrike'] * 100),
                              leg['splitToContracts']) for leg in plan['legs'])
            derived = sorted((leg['right'], round(leg['strike'] * 100), leg['expiry'],
                              leg['contracts'], round(leg['splitToStrike'] * 100),
                              leg['splitToContracts']) for leg in legs)
            assert drafted == derived, (seed, 'plan', index, drafted, derived)
            self.coverage['plans_compared'] += 1
        if store:
            self.verify_store(case)
        self.coverage['seeds'] += 1

    def verify_store(self, case):
        seed = case['seed']
        with tempfile.TemporaryDirectory(prefix='cost-basis-split-') as directory:
            store = CostBasisStore(pathlib.Path(directory) / 'ledger.db').initialize()
            book = store.create_book(account=ACCOUNT, symbol='TQQQ', start_date='2025-08-01')
            bid = book['bookId']
            tokens = iter(range(1, 100000))

            def token():
                return f'split-seed-{seed}-{next(tokens)}'

            def record(events):
                return store.append_split_group(
                    bid, copy.deepcopy(events), client_token=token(), book_identity=book,
                    expected_ledger_version=store.ledger_version(bid))

            def refused(events, branch):
                version = store.ledger_version(bid)
                try:
                    record(events)
                except (InvalidRequestError, PositionOverdrawError):
                    assert store.ledger_version(bid) == version, (seed, branch, 'changed')
                    self.coverage[branch] += 1
                    return
                raise AssertionError((seed, branch, 'corrupted split group accepted'))

            for item in case['items']:
                if not isinstance(item, tuple):
                    store.append_event(bid, copy.deepcopy(item), client_token=token())
                    continue
                header, legs = item[1], item[2]
                if legs:
                    refused([header] + legs[1:], 'store_refused_drop')
                    first = legs[0]
                    if abs(first['contracts']) >= 2:
                        half = first['contracts'] // 2
                        refused([header, {**first, 'contracts': half,
                                          'splitToContracts': -half * header['splitRatio']}]
                                + legs[1:], 'store_refused_partial')
                    refused([header, {**first, 'splitToStrike': round(first['splitToStrike'] + 0.01, 2)}]
                            + legs[1:], 'store_refused_strike')
                written = record([header] + legs)
                # Nothing depends on it yet: void it whole and record it again.
                store.void_split_group(bid, written['splitGroup'], reason='model redo',
                                       client_token=token())
                record([header] + legs)
                self.coverage['store_void_and_redo'] += 1
            stored = store.list_events(bid, limit=2000)['events']
            check(self.bridge.call(op='replay', rows=stored), case['model'], (seed, 'store'))
            backup = store.export_backup(bid)
            plan = store.reset_confirmation(bid)
            store.restore_backup(bid, backup, confirmation=plan['phrase'], client_token=token(),
                                 book_identity=book, expected_ledger_version=store.ledger_version(bid))
            assert store.list_events(bid, include_voided=True, limit=2000)['events'] \
                == backup['payload']['events'], (seed, 'backup')
            self.coverage['store_backup_round_trip'] += 1
        self.coverage['store_seeds'] += 1


def run_campaign(seeds, start=0, store_every=5, report=None):
    campaign = SplitCampaign()
    failures = []
    try:
        for seed in range(start, start + seeds):
            try:
                campaign.verify(seed, store=(seed - start) % store_every == 0)
            except AssertionError as error:
                failures.append((seed, repr(error)[:600]))
                if report:
                    report(f'seed {seed} failed: {repr(error)[:600]}\n  rerun: PYTHONPATH=. '
                           f'python tests/cost_basis_split_campaign_test.py --seeds 1 --start {seed} '
                           '--store-every 1')
    finally:
        campaign.close()
    missing = [branch for branch in REQUIRED if not campaign.coverage[branch]]
    return campaign.coverage, failures, missing


class SplitCampaignTests(unittest.TestCase):
    def test_seeded_split_histories_match_the_independent_model(self):
        coverage, failures, missing = run_campaign(100, start=0, store_every=5)
        self.assertEqual(failures, [])
        self.assertEqual(missing, [], dict(coverage))
        self.assertEqual(coverage['seeds'], 100)
        self.assertEqual(coverage['store_seeds'], 20)

    def test_the_model_restates_the_rounding_rule(self):
        from cost_basis_split_model import half_up
        fixture = json.loads((ROOT / 'tests/fixtures/occ_57592_tqqq_strikes.json').read_text())
        for old, new in fixture['pairs']:
            cents = int(round(F(old) * 100))
            self.assertEqual(half_up(cents, 2), int(round(F(new) * 100)), old)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--seeds', type=int, default=500)
    parser.add_argument('--start', type=int, default=1000)
    parser.add_argument('--store-every', type=int, default=5)
    args = parser.parse_args()
    coverage, failures, missing = run_campaign(args.seeds, args.start, args.store_every, print)
    print(json.dumps({'seeds': coverage['seeds'], 'storeSeeds': coverage['store_seeds'],
                      'failures': len(failures), 'missingBranches': missing,
                      'coverage': dict(sorted(coverage.items()))}, indent=2))
    return 1 if failures or missing else 0


if __name__ == '__main__':
    sys.exit(main())
