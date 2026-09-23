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

IdentityCampaign has no model. Contracts share a strike on both sides of a
split, rows may carry no identity, groups are recorded late or voided, and a
TWS batch closes what is left; every write the store accepts must replay in
the core without a blocking warning.

Normal unittest runs 100 model seeds, 20 of them through SQLite, and 80
identity seeds. The acceptance campaign runs more, for example:

    PYTHONPATH=. python tests/cost_basis_split_campaign_test.py --seeds 500 --start 1000 --store-every 5 --identity-seeds 500

A failure names the seed, the stage and the rerun command.
"""
import argparse
import copy
import json
import pathlib
import random
import re
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


# Mirrors REPLAY_BLOCKING_WARNING in js/cost_basis.js (the futures and
# roll codes cannot occur here).
BLOCKING = re.compile(
    r'^(closes_more_than_open|ibkr_close_open_invalid|ibkr_open_opposes_existing|'
    r'contract_identity_ambiguous|split_ratio_invalid|split_group_invalid|'
    r'split_leg_mismatch|split_series_unconverted)(:|$)')
IDENTITY_REQUIRED = (
    'identity_group_timely', 'identity_group_late', 'identity_group_refused_late',
    'identity_void_accepted', 'identity_void_refused', 'identity_row_refused',
    'identity_bare_row_accepted', 'identity_twin_closed', 'identity_conid_kept',
    'identity_conid_changed', 'identity_batch_closed')
SPLIT_DATE = '2025-11-20'


def identity_case(seed):
    """Random rows around one 2:1 split in which contracts share strikes.

    Before the split: a standard K50 (5001), an adjusted-class 2TQQQ K50
    (5009, always closed before the split) and a standard K100 (1001). After
    it, the converted K100 trades as K50 under a kept (1001) or new (2001)
    conId, the converted K50 as K25. Rows carry a full identity, only a
    symbol, or none (typed by hand). Nothing here is a model: the store
    decides what it accepts, and the campaign checks that everything it
    accepts replays cleanly in the browser core.
    """
    rng = random.Random(seed)
    occ = 'TQQQ  251219P{:08d}'.format
    twin = '2TQQQ 251219P{:08d}'.format

    def identity(con_id, symbol, bare_ok=True):
        style = rng.choice(('full', 'full', 'symbol', 'bare') if bare_ok else ('full',))
        return ({'conId': con_id, 'localSymbol': symbol} if style == 'full'
                else {'localSymbol': symbol} if style == 'symbol' else {})

    def trade(day, strike, contracts, ident, tag=''):
        price = rng.choice((0.5, 1.0, 2.0, 3.5))
        row = {'kind': 'option_trade', 'tradeDate': day, 'right': 'P', 'strike': strike,
               'expiry': '20251219', 'contracts': contracts, 'sharesPerContract': 100,
               'price': price, 'cashAmount': round(-contracts * 100 * price, 2), **ident}
        if tag:
            row['tag'] = tag
        return row

    pre, post = [], []
    fates = {name: rng.choice(('absent', 'closed', 'live') if name != 'T'
                              else ('absent', 'closed')) for name in 'ATC'}
    # Beside the 2TQQQ twin a pre-split K50 row must name its contract, or
    # the store rightly refuses it as ambiguous.
    twins = fates['A'] != 'absent' and fates['T'] != 'absent'
    for name, strike, con_id, symbol in (('A', 50, 5001, occ(50000)),
                                         ('T', 50, 5009, twin(50000)),
                                         ('C', 100, 1001, occ(100000))):
        if fates[name] == 'absent':
            continue
        size = rng.choice((-3, -2, -1, 1, 2))
        opened = f'2025-10-{rng.randint(1, 20):02d}'
        pre.append(trade(opened, strike, size, identity(con_id, symbol, bare_ok=False)))
        if fates[name] == 'closed':
            pre.append(trade(f'2025-11-{rng.randint(1, 19):02d}', strike, -size,
                             identity(con_id, symbol, bare_ok=not (twins and strike == 50)),
                             tag=rng.choice(('', 'ibkr_close'))))
    kept = rng.random() < 0.5
    post50 = (1001 if kept else 2001, occ(50000))
    post25 = (5001 if rng.random() < 0.5 else 2501, occ(25000))
    # Post-split K50 flow: maybe a new opening, then maybe a close or expiry.
    if rng.random() < 0.7:
        size = rng.choice((-2, -1, 1))
        post.append(trade(f'2025-11-{rng.randint(21, 28):02d}', 50, size,
                          identity(*post50, bare_ok=rng.random() < 0.5)))
    for strike, target in ((50, post50), (25, post25)):
        if rng.random() < 0.6:
            post.append({'kind': 'option_expiry', 'tradeDate': '2025-12-19', 'right': 'P',
                         'strike': strike, 'expiry': '20251219', 'sharesPerContract': 100,
                         'contracts': rng.choice((-2, -1, 1, 2, 4)), 'cashAmount': 0,
                         **identity(*target)})
    return {'rng': rng, 'pre': sorted(pre, key=lambda row: row['tradeDate']),
            'post': sorted(post, key=lambda row: row['tradeDate']), 'fates': fates,
            'post50': post50, 'post25': post25, 'kept': kept}


class IdentityCampaign:
    """Every write the store accepts must replay cleanly in the browser core.

    Covers what the model campaign cannot: different contracts at one
    strike across a split, identity-less rows, a group recorded late or
    voided after later rows, an adjusted class beside the standard one, and
    a TWS batch reconciliation that closes the converted series.
    """

    def __init__(self, bridge):
        self.bridge = bridge
        self.coverage = Counter()

    def verify(self, seed):
        case = identity_case(seed)
        rng = case['rng']
        with tempfile.TemporaryDirectory(prefix='cost-basis-identity-') as directory:
            store = CostBasisStore(pathlib.Path(directory) / 'ledger.db').initialize()
            book = store.create_book(account=ACCOUNT, symbol='TQQQ', start_date='2025-09-01')
            bid = book['bookId']
            tokens = iter(range(1, 100000))

            def token():
                return f'identity-seed-{seed}-{next(tokens)}'

            def live():
                return store.list_events(bid, limit=2000)['events']

            def clean(label):
                warnings = [warning for warning in
                            self.bridge.call(op='replay', rows=live())['warnings']
                            if BLOCKING.match(warning)]
                assert not warnings, (seed, label, 'store accepted, core blocks', warnings)

            def attempt(label, action):
                version = store.ledger_version(bid)
                try:
                    result = action()
                except (InvalidRequestError, PositionOverdrawError):
                    assert store.ledger_version(bid) == version, (seed, label, 'refusal wrote')
                    return None
                clean(label)
                return result

            def record_group():
                before = [row for row in live() if row['tradeDate'] < SPLIT_DATE]
                plan = self.bridge.call(op='plan', rows=before, options={
                    'account': ACCOUNT, 'tradeDate': SPLIT_DATE, 'ratio': 2,
                    'ruleRef': 'OCC #57592', 'underlying': 'TQQQ'})
                assert plan['problems'] == [], (seed, 'plan problems', plan['problems'])
                legs = []
                for leg in plan['legs']:
                    leg = {key: value for key, value in leg.items() if key not in (
                        'seriesKey', 'needsStandardConfirmation', 'carriedPremium',
                        'carriedShortPremium')}
                    leg['splitStandardConfirmed'] = True
                    to_con, to_symbol = case['post50'] if leg['strike'] == 100 else case['post25']
                    if rng.random() < 0.8:
                        leg.update(splitToConId=to_con, splitToLocalSymbol=to_symbol)
                    legs.append(leg)
                return store.append_split_group(
                    bid, [plan['header']] + legs, client_token=token(), book_identity=book,
                    expected_ledger_version=store.ledger_version(bid))

            self.coverage['identity_conid_kept' if case['kept'] else 'identity_conid_changed'] += 1
            if case['fates']['T'] == 'closed':
                self.coverage['identity_twin_closed'] += 1
            for row in case['pre']:
                assert attempt('pre', lambda: store.append_event(
                    bid, copy.deepcopy(row), client_token=token())) is not None, (
                    seed, 'pre-split row refused', row)
            late = rng.random() < 0.35
            group = None
            if not late:
                group = attempt('group', record_group)
                # On time, a draft with no problems is what the store accepts.
                assert group is not None, (seed, 'clean timely plan refused')
                self.coverage['identity_group_timely'] += 1
            for row in case['post']:
                accepted = attempt('post', lambda: store.append_event(
                    bid, copy.deepcopy(row), client_token=token()))
                if accepted is None:
                    self.coverage['identity_row_refused'] += 1
                elif 'conId' not in row:
                    self.coverage['identity_bare_row_accepted'] += 1
            if late:
                group = attempt('late group', record_group)
                self.coverage['identity_group_late' if group
                              else 'identity_group_refused_late'] += 1
            if group and rng.random() < 0.6:
                voided = attempt('void group', lambda: store.void_split_group(
                    bid, group['splitGroup'], reason='campaign', client_token=token()))
                self.coverage['identity_void_accepted' if voided
                              else 'identity_void_refused'] += 1
            self.close_by_batch(store, bid, book, token, seed, clean)
        self.coverage['identity_seeds'] += 1

    def close_by_batch(self, store, bid, book, token, seed, clean):
        """Close every open series with one TWS fill through the batch planner."""
        rows = store.list_events(bid, limit=2000)['events']
        ledger = self.bridge.call(op='replay', rows=rows)
        targets, fills = [], []
        for number, option in enumerate(ledger['options']):
            if option['identityConflict'] or len(option['identities']) > 1:
                continue
            fill = {'account': ACCOUNT, 'kind': 'option_trade', 'right': option['right'],
                    'strike': option['strike'], 'expiry': option['expiry'],
                    'sharesPerContract': option['sharesPerContract'],
                    'contracts': -option['contracts'], 'price': 0.1,
                    'cashAmount': round(option['contracts'] * 10, 2),
                    'tradeDate': '2025-12-01',
                    'brokerTimestamp': f'2025-12-01T10:{number:02d}:00',
                    'source': 'execution_report', 'tag': 'ibkr_exec',
                    'externalRef': f'ibkr-exec-identity-{seed}-{number}',
                    'conId': option['conId'], 'localSymbol': option['localSymbol'] or None}
            fills.append(fill)
            targets.append({'account': ACCOUNT, 'kind': 'option', 'right': option['right'],
                            'strike': option['strike'], 'expiry': option['expiry'],
                            'sharesPerContract': option['sharesPerContract'],
                            'conId': option['conId'], 'localSymbol': option['localSymbol'],
                            'key': option['structuralKey'], 'label': option['key'],
                            'ledger': option['contracts'], 'tws': 0,
                            'difference': -option['contracts']})
        if not targets:
            return
        plan = self.bridge.call(op='batch', targets=targets,
                                result={'events': fills, 'problems': []}, rows=rows)
        # The page's own rule for two targets on one structural key: skip both.
        shared = Counter(target['key'] for target in targets)
        expected = [fill for fill, target in zip(fills, targets) if shared[target['key']] == 1]
        assert plan['skipped'] == [] or len(expected) < len(fills), (
            seed, 'batch skipped a clean close', plan['skipped'])
        assert len(plan['events']) == len(expected), (seed, 'batch', plan['skipped'])
        if not expected:
            return
        try:
            store.import_events(
                bid, plan['events'], import_batch_id=token(), client_token_prefix=token(),
                supersede_tws_event_ids=plan['supersedeEventIds'],
                tws_reconciliation=plan['proofs'], book_identity=book,
                expected_ledger_version=store.ledger_version(bid))
        except (InvalidRequestError, PositionOverdrawError) as error:
            raise AssertionError((seed, 'store refused the batch the page planned',
                                  str(error))) from error
        clean('batch import')
        self.coverage['identity_batch_closed'] += 1


def run_identity_campaign(seeds, start=0, report=None, bridge=None):
    own = bridge is None
    campaign = IdentityCampaign(bridge or Bridge())
    failures = []
    try:
        for seed in range(start, start + seeds):
            try:
                campaign.verify(seed)
            except AssertionError as error:
                failures.append((seed, repr(error)[:600]))
                if report:
                    report(f'identity seed {seed} failed: {repr(error)[:600]}\n  rerun: '
                           'PYTHONPATH=. python tests/cost_basis_split_campaign_test.py '
                           f'--seeds 0 --identity-seeds 1 --start {seed}')
    finally:
        if own:
            campaign.bridge.close()
    missing = [branch for branch in IDENTITY_REQUIRED if not campaign.coverage[branch]]
    return campaign.coverage, failures, missing


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

    def test_every_write_the_store_accepts_replays_cleanly(self):
        coverage, failures, missing = run_identity_campaign(80, start=0)
        self.assertEqual(failures, [])
        self.assertEqual(missing, [], dict(coverage))

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
    parser.add_argument('--identity-seeds', type=int, default=200)
    args = parser.parse_args()
    coverage, failures, missing = run_campaign(args.seeds, args.start, args.store_every, print) \
        if args.seeds else (Counter(), [], [])
    identity, identity_failures, identity_missing = run_identity_campaign(
        args.identity_seeds, args.start, print) if args.identity_seeds else (Counter(), [], [])
    print(json.dumps({'seeds': coverage['seeds'], 'storeSeeds': coverage['store_seeds'],
                      'identitySeeds': identity['identity_seeds'],
                      'failures': len(failures) + len(identity_failures),
                      'missingBranches': missing + identity_missing,
                      'coverage': dict(sorted((coverage + identity).items()))}, indent=2))
    return 1 if failures or missing or identity_failures or identity_missing else 0


if __name__ == '__main__':
    sys.exit(main())
