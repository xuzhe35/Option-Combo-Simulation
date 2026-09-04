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
+ parallel shift fits better in 22/34 (mean RMSE 2.26 vs 2.60 vol points);
OTM-put IV rose by about the ATM shift, i.e. the whole smile lifted roughly
in parallel; the shift by tenor relative to ~30 days was ~0.9 at 120 days,
0.57 at 240 and 0.48 at ~400 (about (30/DTE)^0.25, far above sqrt); front beta
was 0.7 (slow -6%), 1.3-1.7 (3-4 weeks, -12..-15%), 2.3-2.9 (days, or with a
VIX spike). The stress test therefore keeps sticky-strike + level shift and
uses exponent 0.25 as its default tenor damping."""
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
        for r in rows:
            if ref is None:
                ref = r['shift_ss']
            oa = f"{r['otm_actual']*100:+.1f}" if r['otm_actual'] is not None else '  -- '
            osd = f"{r['otm_sd']*100:+.1f}" if r['otm_sd'] is not None else '  -- '
            print(f"{r['exp']:<11}{r['dte0']:>5}{r['atm0']*100:>7.1f}{r['atmn']*100:>7.1f}{r['n']:>4} | "
                  f"{r['shift_ss']*100:>+8.1f}p{r['err_ss']*100:>6.2f} | {r['shift_sd']*100:>+8.1f}p{r['err_sd']*100:>6.2f} | {oa} / {osd}")
            summary.append({'drop': drop, **r, 'front_shift': ref})
    # aggregate: which rule fits, and tenor scaling of the level shift
    print('\n=== aggregate ===')
    better_sd = sum(1 for r in summary if r['err_sd'] < r['err_ss'])
    print(f'sticky-delta + parallel shift beats sticky-strike + parallel shift in {better_sd}/{len(summary)} expiry cases')
    print(f"mean rmse: sticky-strike {statistics.mean(r['err_ss'] for r in summary)*100:.2f} pts, sticky-delta {statistics.mean(r['err_sd'] for r in summary)*100:.2f} pts")
    print('\nlevel shift vs front (~30d) and vs sqrt(30/DTE):')
    print(f"{'DTE0':>5} {'ratio to front':>15} {'sqrt(30/DTE)':>13}  (n)")
    buckets = {}
    for r in summary:
        if r['front_shift'] and r['front_shift'] > 0.01:
            b = min(TARGET_DTES, key=lambda t: abs(t - r['dte0']))
            buckets.setdefault(b, []).append(r['shift_sd'] / r['front_shift'])
    for b in sorted(buckets):
        vals = buckets[b]
        print(f"{b:>5} {statistics.median(vals):>15.2f} {math.sqrt(30 / b):>13.2f}  ({len(vals)})")
    print('\nbeta = front ATM shift / |drop| (pts per 1%):')
    for r in summary:
        if abs(r['dte0'] - 30) <= 15 and r['drop'] < 0:
            print(f"  drop {r['drop']:+.1f}%  front shift {r['shift_sd']*100:+.1f} pts  beta {r['shift_sd']*100/(-r['drop']):.2f}")


if __name__ == '__main__':
    main()
