"""Bounded delta debugging for replay/CSV counterexamples, without production oracles."""
import copy
import math
from cost_basis_random_model import Oracle, OPTION_KINDS, csv_text


def legal_history(rows):
    oracle=Oracle()
    for e in sorted(rows,key=lambda e:(e['tradeDate'],e.get('brokerTimestamp',''),e.get('seq',0))):
        if e['kind'] in OPTION_KINDS:
            prior,delta=oracle.quantity(e),e['contracts']
            tag=e.get('tag','')
            if e['kind']!='option_trade' or tag=='ibkr_close':
                if prior*delta>=0 or abs(delta)>abs(prior): return False
            elif tag=='ibkr_open' and prior*delta<0: return False
            elif tag=='ibkr_close_open' and (prior*delta>=0 or abs(delta)<=abs(prior)): return False
        if e['kind']=='futures_roll':
            prior=oracle.futures[e['futureExpiry'][:6]]
            if prior*e['futureContracts']<=0 or abs(e['futureContracts'])>abs(prior): return False
        oracle.apply(e)
    return True


def reduce_case(campaign, max_attempts=120):
    # Transaction/overlap failures require their operation sequence; preserve
    # their full seed replay instead of "shrinking" into an unrelated failure.
    from cost_basis_randomized_test import check_snapshot, replay_expected
    case=copy.deepcopy(campaign.last_case)
    stage=campaign.last_stage
    if stage not in ('core-prefixes','csv-page'): return None
    attempts=0
    def fails(rows):
        nonlocal attempts
        attempts+=1
        if not rows or not legal_history(rows): return False
        try:
            expected=replay_expected(rows)
            if stage=='core-prefixes':
                value=campaign.bridge.call(op='replay',rows=rows,options=case['book'])
                check_snapshot(value,expected,'reduce')
            else:
                for fmt in ('activity','flex'):
                    value=campaign.bridge.call(op='page',csv=csv_text(case,fmt,rows),book=case['book'],rebuild=True)
                    if value['problems']: return True
                    check_snapshot(value['snapshot'],expected,'reduce')
            return False
        except AssertionError: return True
    rows=case['rows']
    if not fails(rows): return None
    chunks=2
    while len(rows)>1 and attempts<max_attempts:
        size=math.ceil(len(rows)/chunks)
        reduced=False
        for start in range(0,len(rows),size):
            candidate=rows[:start]+rows[start+size:]
            if fails(candidate):
                rows=candidate;chunks=max(2,chunks-1);reduced=True;break
            if attempts>=max_attempts: break
        if not reduced:
            if chunks>=len(rows): break
            chunks=min(len(rows),chunks*2)
    return dict(seed=case['seed'],stage=stage,rows=rows,book=case['book'],attempts=attempts)
