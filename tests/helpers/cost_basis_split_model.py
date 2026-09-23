"""Independent model and generator for randomized standard-split histories.

No production imports. Integer cents and Fractions restate the documented
rules (CODE PLAN/COST_BASIS_CORPORATE_ACTIONS_PLAN.md §2.1, §5.1, §15):

- a split multiplies shares by n and converts every option series still live
  on the effective date, whole: contracts times n in the same direction, the
  strike in integer cents divided by n rounded half up, the open premium
  carried unchanged; a series that expired before the date is left alone;
- premium is realized pro rata as a position is closed, and a settlement row
  (assignment or expiry) moves no premium cash of its own.

The generator builds one account's history: share and option trades, a split
at 2025-11-20, post-split trades on the converted contracts, and sometimes a
second split. Every choice is drawn from random.Random(seed).
"""
import random
from collections import Counter
from fractions import Fraction as F

ACCOUNT = 'U1111111'
SYMBOL = 'TQQQ'
PER_CONTRACT = 100
FIRST_SPLIT = '2025-11-20'
SECOND_SPLIT = '2026-01-05'
# Odd cents on purpose: 9997, 10505 and 10649 are OCC #57592's half-cent series.
STRIKE_CENTS = (2500, 3000, 4501, 5000, 6003, 7500, 9997, 10000, 10505, 10649, 12000)
PRE_EXPIRIES = ('20251031', '20251219', '20260116', '20260320')


def half_up(cents, n):
    quotient, remainder = divmod(cents, n)
    return quotient + (1 if remainder * 2 >= n else 0)


def occ_symbol(right, cents, expiry):
    return f'{SYMBOL:<6}{expiry[2:]}{right}{cents * 10:08d}'


def iso(day):
    return f'{day[:4]}-{day[4:6]}-{day[6:]}'


class SplitModel:
    """Shares, cash, premium and option series, keyed by split epoch."""

    def __init__(self):
        self.shares = F(0)
        self.cash = F(0)
        self.realized = F(0)
        self.epoch = 0
        # (right, strike cents, expiry, epoch) -> {'contracts', 'premium', 'symbol'}
        self.series = {}

    def _series(self, right, cents, expiry):
        return self.series.setdefault((right, cents, expiry, self.epoch), {
            'contracts': F(0), 'premium': F(0), 'symbol': None})

    def trade(self, right, cents, expiry, delta, cash_cents):
        entry = self._series(right, cents, expiry)
        prior, delta, cash = entry['contracts'], F(delta), F(cash_cents, 100)
        self.cash += cash
        if prior * delta < 0:
            released = entry['premium'] * abs(delta) / abs(prior)
            entry['premium'] -= released
            self.realized += released + cash
        else:
            entry['premium'] += cash
        entry['contracts'] = prior + delta

    def settle(self, right, cents, expiry, delta, shares, cash_cents):
        entry = self._series(right, cents, expiry)
        prior, delta = entry['contracts'], F(delta)
        released = entry['premium'] * abs(delta) / abs(prior)
        entry['premium'] -= released
        self.realized += released
        entry['contracts'] = prior + delta
        self.shares += shares
        self.cash += F(cash_cents, 100)

    def share_trade(self, shares, cash_cents):
        self.shares += shares
        self.cash += F(cash_cents, 100)

    def live(self, floor=''):
        """Open series of the current epoch still trading on `floor`."""
        return [(key, entry) for key, entry in self.series.items()
                if key[3] == self.epoch and entry['contracts'] and key[2] >= floor]

    def targets(self, n, floor):
        return [(key[0], half_up(key[1], n), key[2]) for key, _ in self.live(floor)]

    def split(self, date, n):
        floor = date.replace('-', '')
        moving = self.live(floor)
        self.shares *= n
        self.epoch += 1
        legs = []
        for (right, cents, expiry, _), entry in moving:
            target = self._series(right, half_up(cents, n), expiry)
            target['contracts'] += entry['contracts'] * n
            target['premium'] += entry['premium']
            target['symbol'] = entry['symbol'] and occ_symbol(right, half_up(cents, n), expiry)
            legs.append({'right': right, 'cents': cents, 'expiry': expiry,
                         'contracts': entry['contracts'], 'to_cents': half_up(cents, n),
                         'symbol': entry['symbol']})
            entry['contracts'] = F(0)
            entry['premium'] = F(0)
        return legs

    def snapshot(self):
        return {
            'shares': self.shares, 'cash': self.cash, 'realized': self.realized,
            'open_premium': sum((entry['premium'] for entry in self.series.values()), F(0)),
            'positions': sorted(
                (key[0], key[1], key[2], entry['contracts'], entry['premium'])
                for key, entry in self.series.items() if entry['contracts']),
        }


def _option_row(date, right, cents, expiry, **fields):
    return {'kind': 'option_trade', 'tradeDate': date, 'account': ACCOUNT, 'right': right,
            'strike': cents / 100, 'expiry': expiry, 'sharesPerContract': PER_CONTRACT,
            'fees': 0, **fields}


def generate(seed, steps=18):
    """One history: a list of rows and ('group', header, legs) items."""
    rng = random.Random(seed)
    model = SplitModel()
    items = []
    coverage = Counter()
    day = [20250901]

    def next_date(limit):
        value = day[0]
        year, month, date = value // 10000, value // 100 % 100, value % 100
        date += rng.randint(1, 3)
        if date > 28:
            date, month = 1, month + 1
            if month > 12:
                month, year = 1, year + 1
        value = year * 10000 + month * 100 + date
        if value >= limit:
            return None
        day[0] = value
        return iso(str(value))

    def share(date):
        if model.shares > 0 and rng.random() < 0.3:
            sold = rng.randint(1, int(model.shares))
            cents = rng.randint(2000, 12000)
            model.share_trade(-sold, sold * cents)
            items.append({'kind': 'share_trade', 'tradeDate': date, 'account': ACCOUNT,
                          'shares': -sold, 'price': cents / 100, 'cashAmount': sold * cents / 100,
                          'fees': 0})
            return
        bought = rng.randint(10, 300)
        cents = rng.randint(2000, 12000)
        model.share_trade(bought, -bought * cents)
        items.append({'kind': 'share_trade', 'tradeDate': date, 'account': ACCOUNT,
                      'shares': bought, 'price': cents / 100, 'cashAmount': -bought * cents / 100,
                      'fees': 0})

    def open_option(date, grid, expiries):
        right = rng.choice('PC')
        cents = rng.choice(grid)
        expiry = rng.choice([value for value in expiries if value > date.replace('-', '')])
        size = rng.randint(1, 4) * rng.choice((1, -1))
        entry = model._series(right, cents, expiry)
        if entry['contracts'] * size < 0:
            size = -size          # never cross zero in one row
        premium = rng.randint(50, 800)
        cash = -size * PER_CONTRACT * premium
        if entry['contracts'] == 0 and entry['symbol'] is None:
            entry['symbol'] = occ_symbol(right, cents, expiry) if rng.random() < 0.8 else ''
        model.trade(right, cents, expiry, size, cash)
        coverage[f"{'long' if size > 0 else 'short'}_{'call' if right == 'C' else 'put'}"] += 1
        items.append(_option_row(date, right, cents, expiry, contracts=size,
                                 price=premium / 100, cashAmount=cash / 100,
                                 localSymbol=entry['symbol'] or None))

    def close_option(date, stage):
        live = model.live(date.replace('-', ''))
        if not live:
            return False
        (right, cents, expiry, _), entry = rng.choice(live)
        held = entry['contracts']
        size = rng.randint(1, int(abs(held)))
        delta = size if held < 0 else -size
        premium = rng.randint(10, 600)
        cash = -delta * PER_CONTRACT * premium
        model.trade(right, cents, expiry, delta, cash)
        coverage[f'{stage}_close'] += 1
        items.append(_option_row(date, right, cents, expiry, contracts=delta,
                                 price=premium / 100, cashAmount=cash / 100,
                                 localSymbol=entry['symbol'] or None))
        return True

    def assign_put(date):
        live = [(key, entry) for key, entry in model.live(date.replace('-', ''))
                if key[0] == 'P' and entry['contracts'] < 0]
        if not live:
            return False
        (right, cents, expiry, _), entry = rng.choice(live)
        size = rng.randint(1, int(abs(entry['contracts'])))
        shares = size * PER_CONTRACT
        cash = -shares * cents
        model.settle(right, cents, expiry, size, shares, cash)
        coverage['post_assignment'] += 1
        items.append(_option_row(date, right, cents, expiry, kind='option_assignment',
                                 contracts=size, shares=shares, cashAmount=cash / 100))
        return True

    def expire(expiry, record_probability):
        for (right, cents, series_expiry, _), entry in model.live():
            if series_expiry != expiry:
                continue
            if rng.random() >= record_probability:
                coverage['expired_unrecorded'] += 1
                continue
            delta = int(-entry['contracts'])
            model.settle(right, cents, expiry, delta, 0, 0)
            coverage['expiry_recorded'] += 1
            items.append(_option_row(iso(expiry), right, cents, expiry, kind='option_expiry',
                                     contracts=delta, cashAmount=0))

    def split(date, n, label):
        floor = date.replace('-', '')
        targets = model.targets(n, floor)
        if len(set(targets)) != len(targets):
            coverage['split_skipped_collision'] += 1
            return False
        legs = model.split(date, n)
        coverage[f'{label}_ratio_{n}'] += 1
        coverage['split_with_options' if legs else 'split_shares_only'] += 1
        if any(leg['cents'] % n for leg in legs):
            coverage['rounded_strike'] += 1
        if any(not leg['symbol'] for leg in legs):
            coverage['confirmed_without_symbol'] += 1
        header = {'kind': 'split', 'tradeDate': date, 'account': ACCOUNT, 'splitRatio': n,
                  'splitRuleRef': f'model memo {label}', 'splitRounding': 'half_up_cent',
                  'cashAmount': 0, 'fees': 0}
        rows = [{'kind': 'option_split', 'tradeDate': date, 'account': ACCOUNT,
                 'right': leg['right'], 'strike': leg['cents'] / 100, 'expiry': leg['expiry'],
                 'sharesPerContract': PER_CONTRACT, 'contracts': float(-leg['contracts']),
                 'splitRatio': n, 'splitToStrike': leg['to_cents'] / 100,
                 'splitToContracts': float(leg['contracts'] * n), 'cashAmount': 0, 'fees': 0,
                 'localSymbol': leg['symbol'] or None,
                 'splitToLocalSymbol': leg['symbol'] and occ_symbol(
                     leg['right'], leg['to_cents'], leg['expiry']) or None,
                 'splitStandardConfirmed': not leg['symbol']} for leg in legs]
        items.append(('group', header, rows))
        return True

    # Before the first split. Some histories hold only shares at the split.
    options_first = rng.random() >= 0.1
    for _ in range(steps):
        date = next_date(20251031)
        if date is None:
            break
        choice = rng.random()
        if choice < 0.25 or not options_first:
            share(date)
        elif choice < 0.8:
            open_option(date, STRIKE_CENTS, PRE_EXPIRIES)
        elif not close_option(date, 'pre'):
            open_option(date, STRIKE_CENTS, PRE_EXPIRIES)
    expire('20251031', 0.6)
    day[0] = 20251101
    for _ in range(rng.randint(0, 3)):
        date = next_date(20251120)
        if date and not (options_first and close_option(date, 'pre')):
            share(date)
    first = rng.choice((2, 2, 3))
    split(FIRST_SPLIT, first, 'first')
    ratio = first

    # After it: trade the converted contracts.
    day[0] = 20251121
    post_grid = sorted({half_up(cents, ratio) for cents in STRIKE_CENTS})
    for _ in range(rng.randint(3, 8)):
        date = next_date(20251219)
        if date is None:
            break
        choice = rng.random()
        if choice < 0.35 and close_option(date, 'post'):
            continue
        if choice < 0.55 and assign_put(date):
            continue
        open_option(date, post_grid, ('20251219', '20260116', '20260320'))
    expire('20251219', 0.7)

    if rng.random() < 0.4:
        second = rng.choice((2, 3))
        if split(SECOND_SPLIT, second, 'second'):
            ratio *= second
            day[0] = 20260106
            for _ in range(rng.randint(1, 3)):
                date = next_date(20260116)
                if date and not close_option(date, 'second'):
                    share(date)

    return {'seed': seed, 'items': items, 'model': model.snapshot(), 'coverage': coverage}
