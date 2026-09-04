#!/usr/bin/env python3
"""Which IV rule fits real QQQ crashes, and how does the IV level shift scale
with tenor?

For each crash episode and a handful of expiries this compares, strike by
strike on the same put contracts, the actual IV change against two rules that
each get one free parallel level shift per expiry:

  sticky-strike : IV(K) keeps its own value, plus the shift
  sticky-delta  : IV(K) becomes the day-0 smile read at the new moneyness
                  ln(K / S_new), plus the shift

and reports the residual RMSE of each, the level shift per expiry relative to
the ~30-day one (the tenor damping the stress test applies), and the front
shift per 1% of drop (the spot-vol beta).  Data: the local options-chain
service (Options DB workspace, EOD chains). Run:

    python3 scripts/skew_regime_study.py            # default episodes
    OPTION_COMBO_CHAIN_SERVICE_URL=http://host:port python3 scripts/skew_regime_study.py

Result 2026-09-05 (seven QQQ crashes 2015-2025, 34 expiry cases): sticky-strike
+ parallel shift fits better in 22/34 (mean RMSE 2.26 vs 2.60 vol points).
Tenor scaling of the STICKY-STRIKE shift relative to the ~30-day one (an
earlier revision divided the sticky-delta shift by the sticky-strike front and
reported ~0.9/0.57/0.48 - wrong, withdrawn): median 0.74 at 60 days, 0.44 at
120, 0.21 at 240, 0.15 at ~400. Fitting ratio = (front_DTE / contract_DTE)^p
on the 25 per-contract rows with each episode's ACTUAL front DTE gives a
least-squares p of 0.76 and a per-row median implied p of 0.64 - both faster
than the square-root rule. Front beta (sticky-strike) 0.3-2.1 across
episodes, too dispersed to set beta from. The stress test keeps sticky-strike
+ level shift and uses p = 0.65 (the robust median side) as its default."""
import json
import math
import statistics
import sys
import urllib.parse
import urllib.request
from datetime import date

import os
BASE = os.environ.get('OPTION_COMBO_CHAIN_SERVICE_URL', 'http://127.0.0.1:8750')
SYMBOL = 'QQQ'
EPISODES = [
    ('2015-08-17', '2015-08-25'),
    ('2018-10-01', '2018-10-29'),
    ('2020-02-19', '2020-03-16'),
    ('2022-01-03', '2022-01-27'),
    ('2023-08-01', '2023-08-18'),
    ('2024-07-10', '2024-08-05'),
    ('2025-04-02', '2025-04-08'),
]
TARGET_DTES = (30, 60, 120, 240, 400)


def get(path, **params):
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    with urllib.request.urlopen(f'{BASE}{path}?{query}', timeout=120) as resp:
        return json.loads(resp.read().decode('utf-8'))


def d(s):
    return date.fromisoformat(s)


def smile(quotes, spot):
    """Sorted (x=ln(K/S), iv) points from OTM puts with a real bid."""
    pts = []
    for q in quotes:
        iv = q.get('impliedVolatility'); k = q.get('strike'); bid = q.get('bid') or 0
        if not iv or not k or bid <= 0 or not (0.03 < iv < 3.0):
            continue
        x = math.log(k / spot)
        if -0.7 <= x <= 0.12:
            pts.append((x, iv, k))
    pts.sort()
    return pts


def interp(pts, x):
    if not pts:
        return None
    if x <= pts[0][0]:
        return pts[0][1]
    if x >= pts[-1][0]:
        return pts[-1][1]
    for (x0, y0, _), (x1, y1, _) in zip(pts, pts[1:]):
        if x0 <= x <= x1:
            return y0 if x1 == x0 else y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return None


def rmse(values):
    return math.sqrt(sum(v * v for v in values) / len(values)) if values else float('nan')


def tenor_ratio_rows(summary):
    """Per-contract rows for the tenor fit: each episode's own front contract
    (its earliest expiry) is the denominator, and BOTH the front's actual DTE
    and the contract's actual DTE are kept. Bucket centres are for display
    only and never enter the fit (Review 21.2)."""
    rows = []
    for r in summary:
        front_shift = r.get('front_shift')
        front_dte = r.get('front_dte')
        if not front_shift or front_shift <= 0.01 or not front_dte:
            continue
        rows.append({'dte0': r['dte0'], 'front_dte': front_dte,
                     'ratio': r['shift_ss'] / front_shift})
    return rows


def fit_tenor_exponent(rows):
    """Least squares through the origin of ln(ratio) on ln(front_dte / dte0),
    over contracts longer than their episode's front with a positive ratio.
    Returns (p_hat, n); (nan, 0) when nothing qualifies."""
    xs, ys = [], []
    for r in rows:
        if r['dte0'] <= r['front_dte'] or not (r['ratio'] > 0):
            continue
        xs.append(math.log(r['front_dte'] / r['dte0']))
        ys.append(math.log(r['ratio']))
    if not xs:
        return float('nan'), 0
    return sum(x * y for x, y in zip(xs, ys)) / sum(x * x for x in xs), len(xs)


def median_row_exponent(rows):
    """Median of the per-contract implied exponent ln(ratio)/ln(front/dte): a
    robust companion to the least-squares fit, which a couple of episodes
    with a tiny front shift can drag around. Returns (median, n)."""
    values = []
    for r in rows:
        if r['dte0'] <= r['front_dte'] or not (r['ratio'] > 0):
            continue
        values.append(math.log(r['ratio']) / math.log(r['front_dte'] / r['dte0']))
    if not values:
        return float('nan'), 0
    return statistics.median(values), len(values)


def study(day0, dayn):
    u0 = get('/v1/underlying', symbol=SYMBOL, date=day0)['bar']['close']
    un = get('/v1/underlying', symbol=SYMBOL, date=dayn)['bar']['close']
    drop = (un / u0 - 1) * 100
    exps0 = {e['expiration'] for e in get('/v1/expirations', symbol=SYMBOL, date=day0)['expirations']}
    expsn = {e['expiration'] for e in get('/v1/expirations', symbol=SYMBOL, date=dayn)['expirations']}
    common = sorted(e for e in exps0 & expsn if (d(e) - d(dayn)).days >= 7)
    chosen = []
    for target in TARGET_DTES:
        best = min(common, key=lambda e: abs((d(e) - d(day0)).days - target), default=None)
        if best and best not in chosen and abs((d(best) - d(day0)).days - target) <= target * 0.5:
            chosen.append(best)
    rows = []
    for exp in chosen:
        q0 = get('/v1/chain', symbol=SYMBOL, date=day0, expiration=exp, type='put')['quotes']
        qn = get('/v1/chain', symbol=SYMBOL, date=dayn, expiration=exp, type='put')['quotes']
        s0 = smile(q0, u0); sn = smile(qn, un)
        if len(s0) < 6 or len(sn) < 6:
            continue
        ivn_by_k = {k: iv for _, iv, k in sn}
        atm0 = interp(s0, 0.0); atmn = interp(sn, 0.0)
        actual, sd_pred, ks = [], [], []
        for x0, iv0, k in s0:
            if k not in ivn_by_k:
                continue
            xn = math.log(k / un)
            if xn < -0.7 or xn > 0.12:
                continue
            actual.append(ivn_by_k[k] - iv0)
            sd_pred.append(interp(s0, xn) - iv0)
            ks.append(k)
        if len(actual) < 6:
            continue
        # best parallel shift for each rule (least squares = mean residual)
        shift_ss = statistics.mean(actual)
        shift_sd = statistics.mean(a - p for a, p in zip(actual, sd_pred))
        err_ss = rmse([a - shift_ss for a in actual])
        err_sd = rmse([a - p - shift_sd for a, p in zip(actual, sd_pred)])
        # strike dependence left over: slope of residual vs moneyness (pts per 10% OTM)
        rows.append({
            'exp': exp, 'dte0': (d(exp) - d(day0)).days, 'dten': (d(exp) - d(dayn)).days,
            'atm0': atm0, 'atmn': atmn, 'n': len(actual),
            'shift_ss': shift_ss, 'shift_sd': shift_sd, 'err_ss': err_ss, 'err_sd': err_sd,
            'otm_actual': statistics.mean(a for a, k in zip(actual, ks) if k < 0.9 * u0) if any(k < 0.9 * u0 for k in ks) else None,
            'otm_sd': statistics.mean(p for p, k in zip(sd_pred, ks) if k < 0.9 * u0) if any(k < 0.9 * u0 for k in ks) else None,
        })
    return u0, un, drop, rows


def main():
    summary = []
    for day0, dayn in EPISODES:
        try:
            u0, un, drop, rows = study(day0, dayn)
        except Exception as exc:  # keep going; report
            print(f'{day0}->{dayn}: FAILED {exc}', file=sys.stderr)
            continue
        print(f'\n=== {day0} -> {dayn}: QQQ {u0:.2f} -> {un:.2f} ({drop:+.1f}%) ===')
        print(f"{'expiry':<11}{'DTE0':>5}{'ATM0':>7}{'ATMn':>7}{'n':>4} | {'shift ss':>9}{'rmse':>7} | {'shift sd':>9}{'rmse':>7} | OTM10%+ actual / sd-only")
        ref = None
        ref_dte = None
        for r in rows:
            if ref is None:
                ref = r['shift_ss']
                ref_dte = r['dte0']
            oa = f"{r['otm_actual']*100:+.1f}" if r['otm_actual'] is not None else '  -- '
            osd = f"{r['otm_sd']*100:+.1f}" if r['otm_sd'] is not None else '  -- '
            print(f"{r['exp']:<11}{r['dte0']:>5}{r['atm0']*100:>7.1f}{r['atmn']*100:>7.1f}{r['n']:>4} | "
                  f"{r['shift_ss']*100:>+8.1f}p{r['err_ss']*100:>6.2f} | {r['shift_sd']*100:>+8.1f}p{r['err_sd']*100:>6.2f} | {oa} / {osd}")
            summary.append({'drop': drop, **r, 'front_shift': ref, 'front_dte': ref_dte})
    # aggregate: which rule fits, and tenor scaling of the level shift
    if not summary:
        sys.exit('no episode produced data: is the options-chain service running at '
                 f'{BASE}? Start it with `python3 chain_server.py` in the Options DB '
                 'workspace (chain_service/), or point OPTION_COMBO_CHAIN_SERVICE_URL at it.')
    print('\n=== aggregate ===')
    better_sd = sum(1 for r in summary if r['err_sd'] < r['err_ss'])
    print(f'sticky-delta + parallel shift beats sticky-strike + parallel shift in {better_sd}/{len(summary)} expiry cases')
    print(f"mean rmse: sticky-strike {statistics.mean(r['err_ss'] for r in summary)*100:.2f} pts, sticky-delta {statistics.mean(r['err_sd'] for r in summary)*100:.2f} pts")
    # Tenor scaling of the STICKY-STRIKE level shift (the rule the stress test
    # uses) relative to the same episode's front (~30d) sticky-strike shift.
    # Mixing in the sticky-delta shift here would compare two different
    # models' intercepts (Review 19.3).
    print('\nlevel shift (sticky-strike) vs front (~30d), against (30/DTE)^p:')
    print(f"{'DTE0':>5} {'ratio to front':>15} {'p=0.5':>7} {'p=0.25':>7}  (n)  [values]")
    ratio_rows = tenor_ratio_rows(summary)
    buckets = {}
    for r in ratio_rows:
        b = min(TARGET_DTES, key=lambda t: abs(t - r['dte0']))
        buckets.setdefault(b, []).append(r['ratio'])
    for b in sorted(buckets):
        vals = buckets[b]
        print(f"{b:>5} {statistics.median(vals):>15.2f} {math.sqrt(30 / b):>7.2f} {(30 / b) ** 0.25:>7.2f}  ({len(vals)})  "
              + ' '.join(f'{v:.2f}' for v in vals))
    print('\nper-contract rows used by the fit (front DTE -> contract DTE : ratio):')
    for r in ratio_rows:
        if r['dte0'] > r['front_dte']:
            print(f"  {r['front_dte']:>4} -> {r['dte0']:>4} : {r['ratio']:+.2f}")
    p_hat, n_fit = fit_tenor_exponent(ratio_rows)
    p_med, n_med = median_row_exponent(ratio_rows)
    print(f'best-fit exponent p in ratio = (front_DTE / contract_DTE)^p, least squares through origin in logs: '
          f'{p_hat:.3f}  (n={n_fit}); median of per-contract implied p: {p_med:.3f}  (n={n_med})')
    print('\nbeta = front sticky-strike shift / |drop| (pts per 1%):')
    for r in summary:
        if abs(r['dte0'] - 30) <= 15 and r['drop'] < 0:
            print(f"  drop {r['drop']:+.1f}%  front shift {r['shift_ss']*100:+.1f} pts  beta {r['shift_ss']*100/(-r['drop']):.2f}")


if __name__ == '__main__':
    main()
