#!/usr/bin/env python3
"""Validate the stress-test model's assumptions against real QQQ chains.

Every knob the cost-basis stress test exposes rests on an assumption. This
script measures each one against the local options-chain service (Options DB
workspace, EOD QQQ chains 2012-2026) and prints a report whose numbers the
panel hints can cite. Run (service on :8750, or set
OPTION_COMBO_CHAIN_SERVICE_URL):

    python3 scripts/stress_model_validation.py            # everything
    python3 scripts/stress_model_validation.py --part A   # one part

Parts:
  A  daily ~30-day ATM IV series -> spot-vol beta by holding period and by
     move size, downside and upside separately; realised vs implied vol for
     the compounding drag term
  B  crash and rally episodes, contract by contract -> extra lift of deep OTM
     puts beyond the ATM shift (skew residual), bid/mark and spread widening
     under stress, and the IV response on rallies
  C  pricing convention -> how far a CRR American / European BSM price at the
     vendor IV sits from the vendor mark (tells which IV convention the DB uses)

The daily series is cached next to this script's output directory so re-runs
are cheap.
"""
import argparse
import json
import math
import os
import statistics
import sys
import urllib.parse
import urllib.request
from datetime import date, timedelta

BASE = os.environ.get('OPTION_COMBO_CHAIN_SERVICE_URL', 'http://127.0.0.1:8750')
SYMBOL = 'QQQ'
CACHE = os.environ.get('STRESS_VALIDATION_CACHE',
                       os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'logs',
                                    'qqq_atm30_series.json'))
CRASHES = [
    ('2015-08-17', '2015-08-25'), ('2018-10-01', '2018-10-29'), ('2020-02-19', '2020-03-16'),
    ('2022-01-03', '2022-01-27'), ('2023-08-01', '2023-08-18'), ('2024-07-10', '2024-08-05'),
    ('2025-04-02', '2025-04-08'),
]
RALLIES = [
    ('2020-03-23', '2020-04-14'), ('2022-06-16', '2022-08-16'), ('2023-10-27', '2023-12-14'),
    ('2025-04-08', '2025-05-12'), ('2019-01-03', '2019-02-25'),
]
TARGET_DTES = (30, 60, 120, 240, 400)


def get(path, **params):
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    with urllib.request.urlopen(f'{BASE}{path}?{query}', timeout=120) as resp:
        return json.loads(resp.read().decode('utf-8'))


def d(s):
    return date.fromisoformat(s)


def smile(quotes, spot, lo=-0.7, hi=0.12):
    pts = []
    for q in quotes:
        iv = q.get('impliedVolatility'); k = q.get('strike'); bid = q.get('bid') or 0
        if not iv or not k or bid <= 0 or not (0.03 < iv < 3.0):
            continue
        x = math.log(k / spot)
        if lo <= x <= hi:
            pts.append((x, iv, k, q))
    pts.sort(key=lambda p: p[0])
    return pts


def interp(pts, x):
    if not pts:
        return None
    if x <= pts[0][0]:
        return pts[0][1]
    if x >= pts[-1][0]:
        return pts[-1][1]
    for a, b in zip(pts, pts[1:]):
        if a[0] <= x <= b[0]:
            return a[1] if b[0] == a[0] else a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0])
    return None


def nearest_expiry(day, target, min_dte=7):
    exps = get('/v1/expirations', symbol=SYMBOL, date=day)['expirations']
    cands = [e['expiration'] for e in exps if (d(e['expiration']) - d(day)).days >= min_dte]
    if not cands:
        return None
    return min(cands, key=lambda e: abs((d(e) - d(day)).days - target))


def atm_iv(day, expiry, spot):
    q = get('/v1/chain', symbol=SYMBOL, date=day, expiration=expiry, type='put',
            minStrike=spot * 0.94, maxStrike=spot * 1.05)['quotes']
    pts = smile(q, spot, -0.08, 0.06)
    return interp(pts, 0.0) if len(pts) >= 3 else None


# ----------------------------------------------------------------- part A
def load_series():
    if os.path.exists(CACHE):
        with open(CACHE, encoding='utf-8') as fh:
            return json.load(fh)
    dates = get('/v1/trading-dates', symbol=SYMBOL, start='2012-01-01', end='2026-12-31')['dates']
    bars = {}
    for year in range(2012, 2027):
        for bar in get('/v1/underlying-bars', symbol=SYMBOL, start=f'{year}-01-01',
                       end=f'{year}-12-31', limit=400).get('bars', []):
            bars[bar['date']] = bar['close']
    series = []
    for index, day in enumerate(dates):
        spot = bars.get(day)
        if not spot:
            continue
        try:
            expiry = nearest_expiry(day, 30)
            iv = atm_iv(day, expiry, spot) if expiry else None
        except Exception as exc:  # keep going: a bad day is a gap, not a crash
            print(f'  {day}: {exc}', file=sys.stderr)
            iv = None
        series.append({'date': day, 'close': spot, 'atm30': iv,
                       'dte': (d(expiry) - d(day)).days if expiry else None})
        if index % 250 == 0:
            print(f'  series {day} ...', file=sys.stderr)
    os.makedirs(os.path.dirname(os.path.abspath(CACHE)), exist_ok=True)
    with open(CACHE, 'w', encoding='utf-8') as fh:
        json.dump(series, fh)
    return series


def regress_origin(xs, ys):
    sxx = sum(x * x for x in xs)
    return sum(x * y for x, y in zip(xs, ys)) / sxx if sxx else float('nan')


def part_a(out):
    series = [row for row in load_series() if row['atm30']]
    out('\n## A. 现货与 30 天 ATM IV 的关系（QQQ 日频，%d 个交易日）' % len(series))
    out('\n### A1 β = ΔIV30（点）/ 跌幅（%），按持有天数与跌幅分档，过原点回归\n')
    out(f"{'天数':>4} | {'跌 2–5%':>10} {'跌 5–10%':>10} {'跌 >10%':>10} {'全部下跌':>10} | {'涨 2–5%':>10} {'涨 >5%':>10} {'全部上涨':>10} | n↓ n↑")
    for h in (1, 2, 5, 10, 20, 40):
        downs = {'2-5': ([], []), '5-10': ([], []), '10+': ([], []), 'all': ([], [])}
        ups = {'2-5': ([], []), '5+': ([], []), 'all': ([], [])}
        for i in range(len(series) - h):
            a, b = series[i], series[i + h]
            if (d(b['date']) - d(a['date'])).days > h * 2.5:
                continue
            r = (b['close'] / a['close'] - 1) * 100
            div = (b['atm30'] - a['atm30']) * 100
            if r < 0:
                mag = -r
                downs['all'][0].append(mag); downs['all'][1].append(div)
                key = '2-5' if 2 <= mag < 5 else ('5-10' if 5 <= mag < 10 else ('10+' if mag >= 10 else None))
                if key:
                    downs[key][0].append(mag); downs[key][1].append(div)
            elif r > 0:
                ups['all'][0].append(r); ups['all'][1].append(div)
                key = '2-5' if 2 <= r < 5 else ('5+' if r >= 5 else None)
                if key:
                    ups[key][0].append(r); ups[key][1].append(div)

        def cell(pair):
            xs, ys = pair
            return f"{regress_origin(xs, ys):>7.2f}({len(xs):>3})" if len(xs) >= 5 else f"{'--':>12}"
        out(f"{h:>4} | {cell(downs['2-5'])} {cell(downs['5-10'])} {cell(downs['10+'])} {cell(downs['all'])} | "
            f"{cell(ups['2-5'])} {cell(ups['5+'])} {cell(ups['all'])} | {len(downs['all'][0])} {len(ups['all'][0])}")
    out('\n（读法：单元格 = β（样本数）。β 为每 1% 现货变动对应的 30 天 ATM IV 变动点数；上涨侧为负表示 IV 回落。）')

    out('\n### A2 实现波动率 vs 起始 ATM IV（20 个交易日窗口）\n')
    ratios, crash_ratios = [], []
    for i in range(len(series) - 20):
        window = series[i:i + 21]
        if (d(window[-1]['date']) - d(window[0]['date'])).days > 40:
            continue
        rets = [math.log(window[j + 1]['close'] / window[j]['close']) for j in range(20)]
        rv = statistics.pstdev(rets) * math.sqrt(252)
        iv = window[0]['atm30']
        r = window[-1]['close'] / window[0]['close'] - 1
        ratios.append(rv / iv)
        if r <= -0.08:
            crash_ratios.append(rv / iv)
    out(f'全部窗口 RV/IV 中位数 {statistics.median(ratios):.2f}（n={len(ratios)}），'
        f'25/75 分位 {statistics.quantiles(ratios, n=4)[0]:.2f} / {statistics.quantiles(ratios, n=4)[2]:.2f}')
    if crash_ratios:
        out(f'跌幅 ≥8% 的窗口 RV/IV 中位数 {statistics.median(crash_ratios):.2f}（n={len(crash_ratios)}）')
    out('（对复利损耗的含义：损耗 ∝ σ²，用起始 ATM IV 代替路径 σ 时，平静期高估、暴跌期接近或低估。）')


# ----------------------------------------------------------------- part B
def episode(day0, dayn):
    u0 = get('/v1/underlying', symbol=SYMBOL, date=day0)['bar']['close']
    un = get('/v1/underlying', symbol=SYMBOL, date=dayn)['bar']['close']
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
        byk_n = {k: q for _, _, k, q in sn}
        atm0 = interp(s0, 0.0); atmn = interp(sn, 0.0)
        pairs = [(k, q0r, byk_n[k]) for _, _, k, q0r in s0 if k in byk_n]
        rows.append({'exp': exp, 'dte0': (d(exp) - d(day0)).days, 'atm0': atm0, 'atmn': atmn,
                     'pairs': pairs, 'u0': u0, 'un': un})
    return u0, un, rows


def part_b(out):
    out('\n## B. 事件逐张检验')
    out('\n### B1 深度价外 Put 相对 ATM 的额外抬升（暴跌）\n')
    out(f"{'事件':<24}{'到期':<11}{'DTE':>4} | {'ATM 抬升':>8} {'价外10-20%':>10} {'价外20%+':>9} | 额外(点)")
    extra_all = []
    spread_rows = []
    for day0, dayn in CRASHES:
        u0, un, rows = episode(day0, dayn)
        for r in rows:
            shift = (r['atmn'] - r['atm0']) * 100
            b1 = [(qn['impliedVolatility'] - q0['impliedVolatility']) * 100 for k, q0, qn in r['pairs'] if 0.8 * u0 <= k < 0.9 * u0]
            b2 = [(qn['impliedVolatility'] - q0['impliedVolatility']) * 100 for k, q0, qn in r['pairs'] if k < 0.8 * u0]
            m1 = statistics.mean(b1) if b1 else None; m2 = statistics.mean(b2) if b2 else None
            extra = (m1 - shift) if m1 is not None else None
            if extra is not None:
                extra_all.append(extra)
            out(f"{day0}→{dayn[5:]:<13}{r['exp']:<11}{r['dte0']:>4} | {shift:>+7.1f} {(f'{m1:+.1f}' if m1 is not None else '--'):>10} {(f'{m2:+.1f}' if m2 is not None else '--'):>9} | {(f'{extra:+.1f}' if extra is not None else '--')}")
            # spreads on OTM puts present both days
            for k, q0, qn in r['pairs']:
                if 0.7 * u0 <= k <= 0.95 * u0 and q0.get('mark') and qn.get('mark') and q0['mark'] > 0.05 and qn['mark'] > 0.05:
                    spread_rows.append({
                        'dte': r['dte0'],
                        'bm0': q0['bid'] / q0['mark'], 'bmn': qn['bid'] / qn['mark'],
                        'sp0': (q0['ask'] - q0['bid']) / q0['mark'], 'spn': (qn['ask'] - qn['bid']) / qn['mark'],
                    })
    if extra_all:
        out(f'\n价外 10–20% Put 相对 ATM 的额外抬升：中位 {statistics.median(extra_all):+.1f} 点，均值 {statistics.mean(extra_all):+.1f} 点（n={len(extra_all)}）')

    out('\n### B2 点差在暴跌中的变化（价外 5–30% Put，同一合约前后对比）\n')
    for lo, hi, label in ((0, 45, '≤45 天'), (45, 150, '45–150 天'), (150, 500, '>150 天')):
        rows = [r for r in spread_rows if lo < r['dte'] <= hi]
        if not rows:
            continue
        out(f"{label:<10} n={len(rows):<4} bid/mark 中位 {statistics.median(r['bm0'] for r in rows):.3f} → {statistics.median(r['bmn'] for r in rows):.3f}"
            f" | 相对点差 (ask−bid)/mark 中位 {statistics.median(r['sp0'] for r in rows):.3f} → {statistics.median(r['spn'] for r in rows):.3f}")
    out('（含义：「今日点差比例外推到情景日」是否成立；比值下降说明暴跌时按买价变现比今天更吃亏。）')

    out('\n### B3 反弹时的 IV 响应（同样逐张，sticky-strike + 平行抬升）\n')
    out(f"{'事件':<24}{'QQQ':>7} | {'到期':<11}{'DTE':>4} {'ATM0':>6}{'ATMn':>6} {'ATM 变动':>8} {'价外Put变动':>10}")
    for day0, dayn in RALLIES:
        try:
            u0, un, rows = episode(day0, dayn)
        except Exception as exc:
            out(f'{day0}→{dayn}: {exc}')
            continue
        rise = (un / u0 - 1) * 100
        for r in rows[:4]:
            shift = (r['atmn'] - r['atm0']) * 100
            otm = [(qn['impliedVolatility'] - q0['impliedVolatility']) * 100 for k, q0, qn in r['pairs'] if 0.8 * u0 <= k < 0.95 * u0]
            out(f"{day0}→{dayn[5:]:<13}{rise:>+6.1f}% | {r['exp']:<11}{r['dte0']:>4} {r['atm0']*100:>6.1f}{r['atmn']*100:>6.1f} {shift:>+8.1f} {(f'{statistics.mean(otm):+.1f}' if otm else '--'):>10}")


# ----------------------------------------------------------------- part C
def norm_cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bsm_put(s, k, t, r, q, sigma):
    if t <= 0:
        return max(k - s, 0)
    d1 = (math.log(s / k) + (r - q + 0.5 * sigma * sigma) * t) / (sigma * math.sqrt(t))
    d2 = d1 - sigma * math.sqrt(t)
    return k * math.exp(-r * t) * norm_cdf(-d2) - s * math.exp(-q * t) * norm_cdf(-d1)


def crr_put(s, k, t, r, q, sigma, steps=121):
    dt = t / steps
    u = math.exp(sigma * math.sqrt(dt)); dn = 1 / u
    p = (math.exp((r - q) * dt) - dn) / (u - dn)
    disc = math.exp(-r * dt)
    values = [max(k - s * (u ** j) * (dn ** (steps - j)), 0) for j in range(steps + 1)]
    for i in range(steps - 1, -1, -1):
        for j in range(i + 1):
            cont = disc * (p * values[j + 1] + (1 - p) * values[j])
            spot = s * (u ** j) * (dn ** (i - j))
            values[j] = max(cont, k - spot)
    return values[0]


def part_c(out):
    out('\n## C. 定价约定：用链库自己的 IV 重定价，与其中间价比较\n')
    out('（链库 IV 若来自欧式 BSM，则美式 CRR 会系统性高于中间价；反之亦然。TWS 的 IV 来自 IB 自己的美式模型，与本页 CRR 一致，此项只说明链库口径，不说明 TWS 口径。）\n')
    samples = [('2019-06-12', 0.022, 0.009), ('2023-08-01', 0.053, 0.006), ('2025-04-02', 0.043, 0.006)]
    out(f"{'日期':<11}{'DTE':>4} {'n':>3} | {'CRR 美式 偏差%':>14} {'BSM 欧式 偏差%':>14} | 中位 |误差|% CRR / BSM")
    for day, rate, div in samples:
        spot = get('/v1/underlying', symbol=SYMBOL, date=day)['bar']['close']
        for target in (30, 120, 365):
            exp = nearest_expiry(day, target)
            if not exp:
                continue
            t = (d(exp) - d(day)).days / 365
            quotes = get('/v1/chain', symbol=SYMBOL, date=day, expiration=exp, type='put')['quotes']
            errs_a, errs_e = [], []
            for q in quotes:
                delta = q.get('delta'); mark = q.get('mark'); iv = q.get('impliedVolatility')
                if not (delta and mark and iv) or not (-0.5 <= delta <= -0.05) or mark < 0.3:
                    continue
                errs_a.append(crr_put(spot, q['strike'], t, rate, div, iv) / mark - 1)
                errs_e.append(bsm_put(spot, q['strike'], t, rate, div, iv) / mark - 1)
            if len(errs_a) < 5:
                continue
            out(f"{day:<11}{(d(exp)-d(day)).days:>4} {len(errs_a):>3} | {statistics.median(errs_a)*100:>+13.2f} {statistics.median(errs_e)*100:>+13.2f} | "
                f"{statistics.median(abs(e) for e in errs_a)*100:.2f} / {statistics.median(abs(e) for e in errs_e)*100:.2f}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--part', choices=['A', 'B', 'C'], default=None)
    parser.add_argument('--out', default=None, help='also write the report here')
    args = parser.parse_args()
    lines = []

    def out(text=''):
        print(text)
        lines.append(text)
    out(f'# 压力测试模型假设验证 · {SYMBOL} · {date.today().isoformat()}')
    for part, fn in (('A', part_a), ('B', part_b), ('C', part_c)):
        if args.part in (None, part):
            fn(out)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as fh:
            fh.write('\n'.join(lines) + '\n')


if __name__ == '__main__':
    main()
