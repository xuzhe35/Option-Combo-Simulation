"""Independent rational-arithmetic oracle and deterministic broker-history generator.

No production imports. The oracle stores individual opening lots and retires a
fraction of every lot on closes (the ledger's documented average allocation),
rather than copying the production accumulator algorithm. Money starts in cents.
"""
import csv
import io
import random
from collections import Counter
from datetime import datetime, timedelta
from fractions import Fraction as F

ACCOUNT = 'U1111111'
OPTION_KINDS = {'option_trade', 'option_assignment', 'option_exercise', 'option_expiry'}

def option_key(e):
    return (e.get('account'), e.get('right'), e.get('strike'), e.get('expiry'),
            e.get('sharesPerContract'), str(e.get('conId') or ''))

class Oracle:
    def __init__(self):
        self.cash = F(0)
        self.shares = F(0)
        self.fees = F(0)
        self.lots = {}
        self.realized = F(0)
        self.short_realized = F(0)
        self.premium = F(0)
        self.futures = Counter()
        self.stock_lots = []
        self.stock_realized = F(0)
        self.future_lots = {}
        self.future_realized = F(0)

    @staticmethod
    def retire_lots(lots, delta, price, fee=F(0)):
        prior = sum((lot[0] for lot in lots), F(0))
        closed = min(abs(prior), abs(delta)) if prior * delta < 0 else F(0)
        realized = F(0)
        if closed:
            for lot in lots:
                q, basis = lot[0] * closed / abs(prior), lot[1] * closed / abs(prior)
                realized += q * price - basis
                lot[0] -= q
                lot[1] -= basis
            realized -= fee * closed / abs(delta)
        remaining = abs(delta) - closed
        if remaining:
            q = remaining * (1 if delta > 0 else -1)
            lots.append([q, q * price + fee * remaining / abs(delta)])
        lots[:] = [lot for lot in lots if lot[0]]
        return realized

    def future_fill(self, month, quantity, price, multiplier):
        self.futures[month] += quantity
        self.future_realized += self.retire_lots(
            self.future_lots.setdefault(month, []), F(quantity), F(str(price)) * multiplier)


    def quantity(self, event):
        return sum((lot[0] for lot in self.lots.get(option_key(event), [])), F(0))

    def apply(self, e):
        if not e.get('includeInCost', True) or e.get('voidedAtUtc'):
            return
        cash, fee = F(str(e.get('cashAmount', 0))), F(str(e.get('fees', 0)))
        self.cash += cash
        self.fees += fee
        if e['kind'] == 'split':
            self.shares *= F(str(e['splitRatio']))
            for lot in self.stock_lots: lot[0] *= F(str(e['splitRatio']))
        else:
            self.shares += F(str(e.get('shares', 0)))
            if e.get('shares'):
                self.stock_realized += self.retire_lots(self.stock_lots, F(str(e['shares'])), F(str(e.get('price', e.get('strike', 0)))), fee)
        if e['kind'] == 'futures_roll':
            self.future_fill(e['futureExpiry'][:6], -e['futureContracts'], e['price'], e['sharesPerContract'])
            self.future_fill(e['rollToExpiry'][:6], e['futureContracts'], e['rollToPrice'], e['sharesPerContract'])
        elif e.get('futureContracts'):
            self.future_fill(e['futureExpiry'][:6], e['futureContracts'], e.get('strike') if e['kind'].startswith('option_') else e['price'], e['sharesPerContract'])
        if e['kind'] not in OPTION_KINDS:
            return
        lots = self.lots.setdefault(option_key(e), [])
        prior = self.quantity(e)
        delta = F(str(e['contracts']))
        row_premium = cash if e['kind'] == 'option_trade' else F(0)
        self.premium += row_premium
        unit_cash = row_premium / abs(delta)
        closed = min(abs(prior), abs(delta)) if prior * delta < 0 else F(0)
        if closed:
            for lot in lots:
                retired = lot[1] * closed / abs(prior)
                lot[0] *= 1 - closed / abs(prior)
                lot[1] -= retired
                self.realized += retired
                if prior < 0:
                    self.short_realized += retired
            self.realized += closed * unit_cash
            if prior < 0:
                self.short_realized += closed * unit_cash
        remaining = abs(delta) - closed
        if remaining:
            lots.append([remaining * (1 if delta > 0 else -1), remaining * unit_cash])
        self.lots[option_key(e)] = [lot for lot in lots if lot[0]]

    def snapshot(self):
        open_money = sum((lot[1] for lots in self.lots.values() for lot in lots), F(0))
        short_money = sum((lot[1] for lots in self.lots.values() for lot in lots if lot[0] < 0), F(0))
        return dict(netCash=float(self.cash), shares=float(self.shares), fees=float(self.fees),
                    optionPremiumNet=float(self.premium), realizedPremium=float(self.realized),
                    openPremium=float(open_money), realizedShortPremium=float(self.short_realized),
                    openShortPremium=float(short_money), stockRealizedPnl=float(self.stock_realized),
                    futuresRealizedPnl=float(self.future_realized),
                    stockAvgCost=float(sum((lot[1] for lot in self.stock_lots),F(0))/self.shares) if self.shares else None,
                    positions={k:float(sum(l[0] for l in lots)) for k,lots in self.lots.items() if lots},
                    futures={k:v for k,v in self.futures.items() if v})

def generate(seed, steps=60, sec_type='STK', extras=False):
    rng = random.Random(seed)
    oracle, events, expected, coverage = Oracle(), [], [], Counter()
    multiplier = rng.choice([50, 100, 130]) if sec_type == 'STK' else 50
    contracts = [dict(account=ACCOUNT, right=right, strike=strike, expiry='20261218',
                      sharesPerContract=multiplier, conId=900000 + i,
                      localSymbol=f'TQQQ 18DEC26 {strike} {right}',
                      optionSecType='OPT' if sec_type == 'STK' else 'FOP')
                 for i,(right,strike) in enumerate((('C',50),('P',50),('C',55),('P',55),('C',60),('P',60)))]
    def add(row, label=None):
        i = len(events)
        stamp = datetime(2026,11,1,10) + timedelta(days=i//12, seconds=(i%12)//2)
        row = dict({'account':ACCOUNT, 'tradeDate':stamp.strftime('%Y-%m-%d'),
                    'brokerTimestamp':stamp.isoformat(), 'source':'csv_import', 'fees':0,
                    'includeInCost':True}, **row)
        row.update(seq=i+1, externalRef=f'random-{seed}-{i}', note='generated regression')
        events.append(row)
        oracle.apply(row)
        expected.append(oracle.snapshot())
        coverage[label or row['kind']] += 1
    if sec_type == 'STK':
        add(dict(kind='share_trade', shares=2000, price=50, cashAmount=-100000, tag='ibkr_open'))
    else:
        add(dict(kind='futures_trade', futureExpiry='202612', futureContracts=2,
                 sharesPerContract=50, price=5100, cashAmount=0))
    for i in range(steps):
        instrument = dict(contracts[i % 6] if i < 12 else rng.choice(contracts))
        prior = int(oracle.quantity(instrument))
        fee = rng.randrange(0, 300) / 100
        size = rng.randint(1, 8)
        if extras and i > 12 and i % 9 == 0:
            if sec_type == 'STK':
                kind = rng.choice(['share_trade','split','dividend','fee','manual_adjust'])
                if kind == 'share_trade':
                    q, p = rng.choice([-1,1])*rng.randint(1,500), rng.randrange(2000,8000)/100
                    add(dict(kind=kind, shares=q, price=p, fees=fee, cashAmount=round(-q*p-fee,2)))
                elif kind == 'split':
                    add(dict(kind=kind, splitRatio=rng.choice([0.5,2]), cashAmount=0))
                else:
                    add(dict(kind=kind, cashAmount=round((1 if kind=='dividend' else -1)*size-fee,2)))
            else:
                month = rng.choice(['202612','202703'])
                quantity = oracle.futures[month]
                if quantity and rng.choice([True,False]):
                    add(dict(kind='futures_roll', futureExpiry=month, futureContracts=quantity,
                             rollToExpiry='202703' if month=='202612' else '202612',
                             sharesPerContract=50, price=5100, rollToPrice=5120,
                             rollGroup=f'roll-{i}', fees=fee, cashAmount=-fee))
                else:
                    add(dict(kind='futures_trade', futureExpiry=month, futureContracts=rng.choice([-3,-1,1,3]),
                             sharesPerContract=50, price=5100+rng.randint(-30,30), fees=fee, cashAmount=-fee))
            continue
        action = 'open' if not prior else (rng.choice(['open','close','reverse','settle']))
        if i < 6: action = 'open'
        if 6 <= i < 12: action = 'reverse'
        direction = 1 if prior > 0 else -1
        if action == 'open':
            delta = size * (direction if prior else rng.choice([-1,1]))
            kind, tag = 'option_trade', 'ibkr_open'
        elif action == 'reverse':
            delta = -direction * (abs(prior)+size)
            kind, tag = 'option_trade', 'ibkr_close_open'
        else:
            delta = -direction * rng.randint(1,abs(prior))
            kind = 'option_trade' if action=='close' else ('option_assignment' if prior<0 else 'option_exercise')
            tag = 'ibkr_close'
        price = rng.randrange(1,2000)/100 if kind=='option_trade' else instrument['strike']
        row = dict(instrument, kind=kind, contracts=delta, tag=tag, price=price, fees=fee)
        if kind == 'option_trade':
            row['cashAmount'] = round(-delta*multiplier*price-fee,2)
        else:
            delivered = delta if instrument['right']=='P' else -delta
            if sec_type == 'STK':
                row.update(shares=delivered*multiplier, cashAmount=round(-delivered*multiplier*price-fee,2))
            else:
                row.update(futureExpiry='202612', futureContracts=delivered, cashAmount=-fee)
        # Same-second sequence is meaningful; excluded independent opens must
        # never provide backing to another contract's subsequent closes.
        add(row, action + ('_long' if (prior or delta)>0 else '_short'))
    for instrument in contracts:
        prior = int(oracle.quantity(instrument))
        if prior and rng.choice([True,False]):
            fee = rng.randrange(0,50)/100
            add(dict(instrument, kind='option_expiry', contracts=-prior, price=0,
                     cashAmount=-fee, fees=fee, tag='ibkr_close'), 'expiry')
            events[-1]['tradeDate']='2026-12-18'
            events[-1]['brokerTimestamp']='2026-12-18T16:00:00'
    return dict(seed=seed, rows=events, expected=expected, coverage=dict(coverage),
                book=dict(account=ACCOUNT,symbol='TQQQ' if sec_type=='STK' else 'ES',
                          secType=sec_type,currency='USD',defaultSharesPerContract=multiplier))

def csv_text(case, format_name='activity', rows=None):
    """Serialize generated economic events to independent broker-shaped CSV.

    Stock deliveries are separate broker rows; parser must combine them once.
    All monetary fields come from the generator, never a parser round trip.
    """
    rows = case['rows'] if rows is None else rows
    out = io.StringIO()
    writer = csv.writer(out, lineterminator='\n')
    book=case['book']
    if format_name=='activity':
        writer.writerows([['Statement','Data','Period','November 1, 2026 - December 18, 2026'],
                          ['Account Information','Header','Field Name','Field Value'],
                          ['Account Information','Data','Account',ACCOUNT],
                          ['Financial Instrument Information','Header','Asset Category','Symbol','Description','Conid','Underlying','Listing Exch','Multiplier','Expiry','Delivery Month','Type','Strike']])
        for e in {option_key(e):e for e in rows if e['kind'] in OPTION_KINDS}.values():
            writer.writerow(['Financial Instrument Information','Data','Equity and Index Options',
                             e['localSymbol'],e['localSymbol'],e['conId'],'TQQQ','CBOE',e['sharesPerContract'],'2026-12-18','','',e['strike']])
        writer.writerow(['Trades','Header','DataDiscriminator','Asset Category','Currency','Symbol','Date/Time','Quantity','T. Price','Proceeds','Comm/Fee','Code'])
    else:
        writer.writerow(['ClientAccountID','UnderlyingSymbol','Symbol','AssetClass','TradeDate','Quantity','TradePrice','Proceeds','IBCommission','PutCall','Strike','Expiry','Multiplier','TradeID','Notes/Codes','Currency','Conid'])
    for e in rows:
        assert e['kind'] in OPTION_KINDS | {'share_trade'}
        option = e['kind'] in OPTION_KINDS
        code = {'ibkr_open':'O','ibkr_close':'C','ibkr_close_open':'C;O;P'}[e.get('tag','ibkr_open')]
        if e['kind'] in ('option_assignment','option_exercise','option_expiry'):
            code={'option_assignment':'A','option_exercise':'Ex','option_expiry':'C;Ep'}[e['kind']]
        legs = [(option, e.get('contracts') if option else e['shares'],
                 e['price'] if e['kind'] in ('share_trade','option_trade') else 0,
                 e['cashAmount'] if e['kind'] in ('share_trade','option_trade','option_expiry') else -e['fees'], e['fees'])]
        if e['kind'] in ('option_assignment','option_exercise'):
            legs.append((False,e['shares'],e['strike'],e['cashAmount']+e['fees'],0))
        for index,(is_option,qty,price,cash,fees) in enumerate(legs):
            symbol=e['localSymbol'] if is_option else 'TQQQ'
            timestamp=e['brokerTimestamp'].replace('T',', ')
            proceeds=round(cash+fees,2)
            if format_name=='activity':
                writer.writerow(['Trades','Data','Order','Equity and Index Options' if is_option else 'Stocks','USD',symbol,timestamp,qty,price,proceeds,-fees,code])
            else:
                writer.writerow([ACCOUNT,'TQQQ',symbol,'OPT' if is_option else 'STK',timestamp,qty,price,
                                 proceeds,-fees,e['right'] if is_option else '', e['strike'] if is_option else '',
                                 e['expiry'] if is_option else '',e['sharesPerContract'] if is_option else 1,
                                 e['externalRef']+f'-{index}',code,'USD',e['conId'] if is_option else ''])
    if format_name=='activity':
        oracle=Oracle()
        for e in rows: oracle.apply(e)
        writer.writerow(['Open Positions','Header','DataDiscriminator','Asset Category','Currency','Symbol','Quantity','Multiplier','Cost Basis'])
        if oracle.shares:
            writer.writerow(['Open Positions','Data','Summary','Stocks','USD','TQQQ',float(oracle.shares),1,0])
        instruments={option_key(e):e for e in rows if e['kind'] in OPTION_KINDS}
        for key,qty in oracle.snapshot()['positions'].items():
            e=instruments[key]
            writer.writerow(['Open Positions','Data','Summary','Equity and Index Options','USD',e['localSymbol'],qty,e['sharesPerContract'],0])
    return out.getvalue()
