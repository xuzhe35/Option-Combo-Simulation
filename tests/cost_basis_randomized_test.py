"""Seeded model-based testing across replay, CSV/page, and temporary SQLite.

Normal unittest runs a bounded smoke corpus. The CLI runs a larger reproducible
campaign. No real user database, browser, broker, or private report is involved.
"""
import copy
import json
import math
import os
import pathlib
import random
import subprocess
import sys
import tempfile
import unittest
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT/'tests/helpers'))
from cost_basis_random_model import generate, Oracle, option_key, csv_text
from cost_basis_store import (CostBasisStore, PositionOverdrawError, LedgerChangedError,
                              ImportRevisionConflictError, InvalidRequestError)

class Bridge:
    def __init__(self):
        self.process = subprocess.Popen(['node', str(ROOT/'tests/helpers/cost_basis_random_bridge.js')],
            cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
    def call(self, **data):
        self.process.stdin.write(json.dumps(data)+'\n')
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise AssertionError('JavaScript worker exited unexpectedly')
        response=json.loads(line)
        if 'error' in response:
            raise AssertionError(response['error'])
        return response['result']
    def close(self):
        self.process.stdin.close()
        self.process.stdout.close()
        self.process.wait(timeout=10)


def check_snapshot(actual, expected, label):
    for key in ('netCash','shares','fees','optionPremiumNet','realizedPremium',
                'openPremium','realizedShortPremium','openShortPremium','stockRealizedPnl','futuresRealizedPnl'):
        value=actual['combined'].get(key,0)
        assert value is not None and abs(value-expected[key]) <= 0.0001, (label,key,value,expected[key])
    for key,value in actual['combined'].items():
        if isinstance(value,(int,float)):
            assert math.isfinite(value), (label,'nonfinite',key,value)
    if expected['stockAvgCost'] is not None:
        assert abs(actual['combined']['stockAvgCost']-expected['stockAvgCost'])<0.0001, (label,'stockAvgCost')
    positions={option_key(e):e['contracts'] for e in actual['options']}
    assert positions==expected['positions'], (label,'positions',positions,expected['positions'])
    futures={e['expiry'][:6]:e['contracts'] for e in actual['futures']}
    assert futures==expected['futures'], (label,'futures',futures,expected['futures'])


def replay_expected(rows):
    oracle=Oracle()
    for e in sorted(rows,key=lambda e:(e['tradeDate'], e.get('brokerTimestamp') or e['tradeDate']+'T23:59:59',e.get('seq',0))):
        oracle.apply(e)
    return oracle.snapshot()

class Campaign:
    def __init__(self):
        self.bridge=Bridge()
        self.coverage=Counter()
        self.last_case=None
        self.last_stage=''
    def close(self):
        self.bridge.close()
    def verify_case(self, seed, steps=60, store=False):
        self.last_stage='core-prefixes'
        case=generate(seed,steps,sec_type='FUT' if seed%2 else 'STK',extras=True)
        self.last_case=case
        self.coverage.update(case['coverage'])
        core_case=case
        result=self.bridge.call(op='prefixes',rows=case['rows'],options=case['book'])
        for i,(actual,expected) in enumerate(zip(result,case['expected'])):
            check_snapshot(actual,expected,(seed,'prefix',i))
            allowed=('net_short_shares','split_crosses_open_option:','mixed_future_directions','legacy_split_same_day:')
            assert all(w.startswith(allowed) for w in actual['warnings']), (seed,i,actual['warnings'])
        self.coverage['core_prefixes'] += len(result)
        # Input array order may change; explicit broker time + stable seq is truth.
        shuffled=copy.deepcopy(case['rows']);random.Random(seed+11).shuffle(shuffled)
        check_snapshot(self.bridge.call(op='replay',rows=shuffled,options=case['book']),case['expected'][-1],(seed,'shuffle'))
        # Excluded/voided independent lots cannot change cash, fees or positions.
        ignored=copy.deepcopy(case['rows'][:min(5,len(case['rows']))])
        for i,e in enumerate(ignored):
            if i%2: e['voidedAtUtc']='2026-12-31T00:00:00Z'
            else: e['includeInCost']=False
            e['conId']=999999
        check_snapshot(self.bridge.call(op='replay',rows=case['rows']+ignored,options=case['book']),case['expected'][-1],(seed,'ignored'))
        self.coverage['shuffle_and_exclusion'] += 2
        self.last_stage='csv-page'
        case=generate(seed,steps,extras=False)
        self.last_case=case
        pages={}
        for format_name in ('activity','flex'):
            text=csv_text(case,format_name)
            page=self.bridge.call(op='page',csv=text,book=case['book'],rebuild=True)
            assert not page['problems'], (seed,format_name,page['problems'])
            check_snapshot(page['snapshot'],case['expected'][-1],(seed,format_name))
            assert len(page['rows'])==len(case['rows']), (seed,format_name,'row count',len(page['rows']),len(case['rows']))
            pages[format_name]=page['rows']
            existing=[dict(e,eventId=f'old-{i}',seq=i+1) for i,e in enumerate(page['rows'])]
            repeated=self.bridge.call(op='page',csv=text,book=case['book'],existing=existing)
            assert not repeated['problems'] and not repeated['rows'], (seed,format_name,'repeat',repeated['problems'])
            rebuilt=self.bridge.call(op='page',csv=text,book=case['book'],existing=existing,rebuild=True)
            assert not rebuilt['problems'] and len(rebuilt['rows'])==len(existing), (seed,format_name,'rebuild')
            check_snapshot(rebuilt['snapshot'],case['expected'][-1],(seed,format_name,'rebuild'))
            cut=random.Random(seed).randint(1,len(existing)-1)
            partial=self.bridge.call(op='page',csv=text,book=case['book'],existing=existing[:cut])
            assert not partial['problems'], (seed,format_name,'overlap',partial['problems'])
            check_snapshot(partial['snapshot'],case['expected'][-1],(seed,format_name,'overlap'))
            assert len(partial['rows'])==len(existing)-cut
            self.coverage['page_'+format_name] += 4
        tws=[dict(e,source='execution_report',tag='ibkr_exec',externalRef=f'ibkr-exec-{seed}-{i}',
                  eventId=f'exec-{i}',seq=i+1) for i,e in enumerate(pages['activity'][:7+seed%7])]
        cross=self.bridge.call(op='page',csv=csv_text(case),book=case['book'],existing=tws)
        assert not cross['problems'], (seed,'TWS-to-CSV',cross['problems'])
        check_snapshot(cross['snapshot'],case['expected'][-1],(seed,'TWS-to-CSV'))
        assert len(cross['rows'])==len(pages['activity'])-len(tws)
        self.coverage['tws_csv_overlap']+=1
        self.verify_invalid(seed)
        if store:
            self.last_stage='sqlite-state-machine'
            self.verify_store(case,pages['activity'])
            self.verify_invalid_store(seed)
            if core_case['book']['secType']=='FUT': self.verify_futures_store(core_case)
        self.coverage['seeds']+=1

    def verify_invalid(self, seed):
        self.last_stage='invalid-mutations'
        base=generate(seed,1)['rows'][1]
        quantity=1+seed%11
        opening=dict(base,contracts=quantity,tag='ibkr_open',cashAmount=-quantity*100,price=1)
        baseline=replay_expected([opening])
        for tag,delta,con_id in [('ibkr_close',-quantity-1,opening['conId']),
                                 ('ibkr_close',1,opening['conId']),
                                 ('ibkr_open',-1,opening['conId']),
                                 ('ibkr_close_open',-quantity,opening['conId']),
                                 ('ibkr_close_open',-quantity-2,999999),
                                 ('ibkr_close_open',3,opening['conId'])]:
            bad=dict(opening,seq=3,contracts=delta,tag=tag,conId=con_id,brokerTimestamp='2026-11-01T12:00:00',cashAmount=777)
            result=self.bridge.call(op='replay',rows=[opening,bad])
            assert result['warnings'], (seed,'invalid accepted',tag,delta)
            check_snapshot(result,baseline,(seed,'invalid cash isolation',tag,delta))
            self.coverage['invalid_core_mutations']+=1

    def verify_store(self, case, imported):
        seed=case['seed']
        with tempfile.TemporaryDirectory(prefix='cost-basis-random-') as directory:
            store=CostBasisStore(pathlib.Path(directory)/'ledger.db').initialize()
            book=store.create_book(account=case['book']['account'],symbol='TQQQ',start_date='2026-01-01')
            bid=book['bookId'];counter=0
            def token():
                nonlocal counter
                counter+=1;return f'seed-{seed}-{counter}'
            def credentials():
                return dict(book_identity=book,expected_ledger_version=store.ledger_version(bid))
            def append_batch(rows, **kw):
                return store.import_events(bid,rows,import_batch_id=token(),client_token_prefix=token(),**credentials(),**kw)
            def verify(rows,label):
                actual=store.list_events(bid,limit=1000)['events']
                check_snapshot(self.bridge.call(op='replay',rows=actual),replay_expected(rows),(seed,label))
                return actual
            # Random chunking, overlapping retries, and post-write readback.
            rng=random.Random(seed)
            offset=0
            while offset<len(imported):
                stop=min(len(imported),offset+rng.randint(1,12))
                chunk=imported[offset:stop]
                args=dict(import_batch_id=token(),client_token_prefix=token(),**credentials())
                response=store.import_events(bid,chunk,**args)
                assert response['inserted']==len(chunk)
                retry=store.import_events(bid,chunk,**args)
                assert retry['idempotentReplay']
                verify(imported[:stop],'chunk')
                offset=stop;self.coverage['sqlite_chunks']+=1
            assert append_batch(imported)['inserted']==0
            original=verify(imported,'repeat')
            version=store.ledger_version(bid)
            # Same reference with altered economics must refuse and keep state.
            changed=dict(imported[0],cashAmount=imported[0]['cashAmount']+1)
            try: append_batch([changed])
            except ImportRevisionConflictError: pass
            else: raise AssertionError((seed,'revision silently accepted'))
            assert store.ledger_version(bid)==version
            # New submission with stale preview must fail even when rows duplicate.
            try: store.import_events(bid,imported,import_batch_id=token(),client_token_prefix=token(),
                    book_identity=book,expected_ledger_version={'digest':'stale'})
            except LedgerChangedError: pass
            else: raise AssertionError((seed,'stale version accepted'))
            backup=store.export_backup(bid)
            plan=store.reset_confirmation(bid)
            rebuilt=store.rebuild_book(bid,imported,confirmation=plan['phrase'],client_token=token(),
                                      import_batch_id=token(),**credentials())
            verify(imported,'rebuild')
            plan=store.reset_confirmation(bid)
            store.restore_book_reset(bid,rebuilt['resetId'],confirmation=plan['phrase'],client_token=token(),**credentials())
            verify(imported,'archive restore')
            # A terminal row can be voided; restore the exact JSON backup after.
            last=store.list_events(bid,limit=1000)['events'][-1]
            store.void_event(bid,last['eventId'],reason='random terminal correction',client_token=token())
            verify(imported[:-1],'terminal void')
            plan=store.reset_confirmation(bid)
            store.restore_backup(bid,backup,confirmation=plan['phrase'],client_token=token(),**credentials())
            verify(imported,'backup restore')
            # Complete history with missing opening must roll back the whole rebuild.
            invalid=[dict(imported[1],tag='ibkr_close_open',contracts=-10,cashAmount=100)]
            resets_before=store.list_book_resets(bid)
            batches_before=store.list_import_batches(bid)
            plan=store.reset_confirmation(bid)
            try: store.rebuild_book(bid,invalid,confirmation=plan['phrase'],client_token=token(),
                                   import_batch_id=token(),**credentials())
            except PositionOverdrawError: pass
            else: raise AssertionError((seed,'invalid rebuild accepted'))
            assert store.ledger_version(bid)==plan['ledgerVersion']
            verify(imported,'failed rebuild rollback')
            assert store.list_book_resets(bid)==resets_before
            assert store.list_import_batches(bid)==batches_before
            # Broker timestamps establish a total order independent of payload order.
            unordered=copy.deepcopy(imported)
            for i,e in enumerate(unordered):
                e['brokerTimestamp']=e['tradeDate']+f'T10:{i//60:02}:{i%60:02}'
            expected=replay_expected(unordered)
            rng.shuffle(unordered)
            plan=store.reset_confirmation(bid)
            store.rebuild_book(bid,unordered,confirmation=plan['phrase'],client_token=token(),
                               import_batch_id=token(),**credentials())
            check_snapshot(self.bridge.call(op='replay',rows=store.list_events(bid,limit=1000)['events']),
                           expected,(seed,'unordered rebuild'))
            # Repeat in a fresh book to exercise append's separate transaction path.
            other=store.create_book(account=book['account'],symbol='QQQ',start_date='2026-01-01')
            store.import_events(other['bookId'],unordered,import_batch_id=token(),client_token_prefix=token(),
                book_identity=other,expected_ledger_version=store.ledger_version(other['bookId']))
            check_snapshot(self.bridge.call(op='replay',rows=store.list_events(other['bookId'],limit=1000)['events']),
                           expected,(seed,'unordered append'))
            # Two writers review the same version. Exactly one may commit.
            if seed%10==0:
                stamp=store.ledger_version(bid)
                barrier=Barrier(2)
                candidates=[dict(kind='fee',account=book['account'],tradeDate='2026-12-31',
                                 cashAmount=-i-1,externalRef=f'concurrent-{i}') for i in range(2)]
                def race(i):
                    barrier.wait(timeout=10)
                    try:
                        store.import_events(bid,[candidates[i]],import_batch_id=f'race-batch-{seed}-{i}',
                            client_token_prefix=f'race-token-{seed}-{i}',book_identity=book,expected_ledger_version=stamp)
                        return i
                    except LedgerChangedError: return None
                with ThreadPoolExecutor(max_workers=2) as pool:
                    outcomes=list(pool.map(race,range(2)))
                winners=[i for i in outcomes if i is not None]
                assert len(winners)==1,(seed,'concurrent writers',outcomes)
                verify(unordered+[candidates[winners[0]]],'concurrent commit')
                self.coverage['concurrent_version_races']+=1
            self.coverage['sqlite_state_machines']+=1

    def verify_invalid_store(self, seed):
        base=generate(seed,1)['rows'][1]
        quantity=1+seed%11
        opening=dict(base,contracts=quantity,tag='ibkr_open',cashAmount=-quantity*100,price=1)
        with tempfile.TemporaryDirectory(prefix='cost-basis-invalid-random-') as directory:
            store=CostBasisStore(pathlib.Path(directory)/'ledger.db').initialize()
            book=store.create_book(account='U1111111',symbol='TQQQ',start_date='2026-01-01')
            bid=book['bookId']
            accepted=store.append_event(bid,opening,client_token=f'negative-open-{seed}')
            version=store.ledger_version(bid)
            cases=[('ibkr_close',-quantity-1,base['conId']), ('ibkr_open',-1,base['conId']),
                   ('ibkr_close_open',-quantity,base['conId']), ('ibkr_close_open',-quantity-2,999999),
                   ('ibkr_close_open',quantity+1,base['conId'])]
            for i,(tag,delta,con_id) in enumerate(cases):
                bad=dict(opening,tag=tag,contracts=delta,conId=con_id,externalRef=f'bad-{i}',
                         brokerTimestamp='2026-11-01T12:00:00')
                for override in (False,True):
                    try: store.import_events(bid,[bad],import_batch_id=f'invalid-batch-{seed}-{i}-{override}',
                            client_token_prefix=f'invalid-token-{seed}-{i}-{override}',book_identity=book,
                            expected_ledger_version=version,allow_overdraw=override)
                    except PositionOverdrawError: pass
                    else: raise AssertionError((seed,'invalid store accepted',tag,delta,override))
                    assert store.ledger_version(bid)==version
                    self.coverage['invalid_store_mutations']+=1
            backup=store.export_backup(bid)
            backup['sha256']='0'*64
            plan=store.reset_confirmation(bid)
            try: store.restore_backup(bid,backup,confirmation=plan['phrase'],client_token=f'bad-backup-{seed}',
                    book_identity=book,expected_ledger_version=version)
            except InvalidRequestError: pass
            else: raise AssertionError((seed,'corrupt backup accepted'))
            assert store.ledger_version(bid)==version
            store.void_event(bid,accepted['event']['eventId'],reason='test explicit void',client_token=f'void-open-{seed}')
            void_version=store.ledger_version(bid)
            try: store.import_events(bid,[opening],import_batch_id=f'voided-batch-{seed}',client_token_prefix=f'voided-token-{seed}',
                    book_identity=book,expected_ledger_version=void_version)
            except ImportRevisionConflictError: pass
            else: raise AssertionError((seed,'voided event resurrected by duplicate import'))
            assert store.ledger_version(bid)==void_version
            self.coverage['backup_corruption_and_voided_duplicate']+=2

    def verify_futures_store(self, case):
        seed=case['seed']
        with tempfile.TemporaryDirectory(prefix='cost-basis-futures-random-') as directory:
            store=CostBasisStore(pathlib.Path(directory)/'ledger.db').initialize()
            book=store.create_book(account=case['book']['account'],symbol='ES',sec_type='FUT',
                                   default_shares_per_contract=50,start_date='2026-01-01')
            bid=book['bookId']
            store.import_events(bid,case['rows'],import_batch_id=f'futures-batch-{seed}',
                client_token_prefix=f'futures-token-{seed}',book_identity=book,
                expected_ledger_version=store.ledger_version(bid))
            persisted=store.list_events(bid,limit=1000)['events']
            check_snapshot(self.bridge.call(op='replay',rows=persisted,options=case['book']),
                           case['expected'][-1],(seed,'FUT persisted'))
            plan=store.reset_confirmation(bid)
            shuffled=copy.deepcopy(case['rows'])
            for i,e in enumerate(shuffled):e['brokerTimestamp']=e['tradeDate']+f'T10:{i//60:02}:{i%60:02}'
            random.Random(seed).shuffle(shuffled)
            store.rebuild_book(bid,shuffled,confirmation=plan['phrase'],client_token=f'futures-rebuild-{seed}',
                import_batch_id=f'futures-rebuilt-batch-{seed}',book_identity=book,
                expected_ledger_version=plan['ledgerVersion'])
            check_snapshot(self.bridge.call(op='replay',rows=store.list_events(bid,limit=1000)['events'],options=case['book']),
                           case['expected'][-1],(seed,'FUT unordered rebuild'))
            self.coverage['futures_sqlite_state_machines']+=1

class RandomizedLedgerTests(unittest.TestCase):
    def test_counterexample_reducer_retains_the_trigger(self):
        from types import SimpleNamespace
        from cost_basis_random_reduce import reduce_case
        rows=[dict(kind='fee',account='U1111111',tradeDate='2026-11-01',cashAmount=-i-1,
                   externalRef=ref,seq=i+1) for i,ref in enumerate(('noise-before','bad-row','noise-after'))]
        def faulty_replay(**args):
            summary=replay_expected(args['rows'])
            if any(e['externalRef']=='bad-row' for e in args['rows']): summary['netCash']+=1
            return dict(combined=summary,options=[],futures=[])
        campaign=SimpleNamespace(last_case=dict(seed=0,rows=rows,book={'secType':'STK'}),
                                 last_stage='core-prefixes',bridge=SimpleNamespace(call=faulty_replay))
        result=reduce_case(campaign)
        self.assertEqual([e['externalRef'] for e in result['rows']],['bad-row'])

    def test_independent_oracle_hand_calculated_reversal_and_stock_split(self):
        oracle=Oracle()
        base=dict(kind='option_trade',account='U1111111',right='C',strike=50,
                  expiry='20261218',sharesPerContract=100,conId=1)
        oracle.apply(dict(base,contracts=2,cashAmount=-201))
        oracle.apply(dict(base,contracts=-5,cashAmount=499))
        result=oracle.snapshot()
        self.assertAlmostEqual(result['realizedPremium'],-1.4)
        self.assertAlmostEqual(result['openShortPremium'],299.4)
        oracle.apply(dict(base,contracts=2,cashAmount=-150))
        self.assertAlmostEqual(oracle.snapshot()['realizedPremium'],48.2)
        self.assertAlmostEqual(oracle.snapshot()['openPremium'],99.8)
        oracle.apply(dict(kind='share_trade',shares=100,price=50,fees=1,cashAmount=-5001))
        oracle.apply(dict(kind='share_trade',shares=-150,price=60,fees=3,cashAmount=8997))
        oracle.apply(dict(kind='split',splitRatio=2,cashAmount=0))
        self.assertEqual(oracle.snapshot()['shares'],-100)
        self.assertEqual(oracle.snapshot()['stockRealizedPnl'],997)
        self.assertEqual(oracle.snapshot()['stockAvgCost'],29.99)

    def test_generated_statement_account_and_missing_delivery_block(self):
        bridge=Bridge()
        try:
            case=generate(95,80)
            text=csv_text(case)
            wrong=text.replace('Data,Account,U1111111','Data,Account,U9999999')
            self.assertTrue(bridge.call(op='page',csv=wrong,book=case['book'])['problems'])
            lines=text.splitlines()
            delivery=next(i for i,line in enumerate(lines) if line.startswith('Trades,Data,Order,Stocks')
                          and line.endswith((',A',',Ex')))
            del lines[delivery]
            self.assertTrue(bridge.call(op='page',csv='\n'.join(lines),book=case['book'])['problems'])
        finally: bridge.close()

    def test_unordered_adjusted_contract_infers_size_from_complete_batch(self):
        for size in (50,130):
            for mode in ('append','rebuild'):
                with self.subTest(size=size,mode=mode), tempfile.TemporaryDirectory() as directory:
                    store=CostBasisStore(pathlib.Path(directory)/'ledger.db').initialize()
                    book=store.create_book(account='U1111111',symbol='TQQQ',start_date='2026-01-01')
                    bid=book['bookId']
                    base=dict(account=book['account'],kind='option_trade',right='P',strike=50,
                              expiry='20261218',price=1,fees=0,conId=123)
                    rows=[dict(base,tradeDate='2026-11-02',contracts=1,tag='ibkr_close',cashAmount=-size),
                          dict(base,tradeDate='2026-11-01',contracts=-1,tag='ibkr_open',cashAmount=size,sharesPerContract=size)]
                    credentials=dict(book_identity=book,expected_ledger_version=store.ledger_version(bid))
                    if mode=='append':
                        store.import_events(bid,rows,import_batch_id='adjusted-batch',client_token_prefix='adjusted-token',**credentials)
                    else:
                        plan=store.reset_confirmation(bid)
                        store.rebuild_book(bid,rows,import_batch_id='adjusted-batch',client_token='adjusted-token',
                                           confirmation=plan['phrase'],**credentials)
                    self.assertEqual({e['sharesPerContract'] for e in store.list_events(bid)['events']},{size})

    def test_ambiguous_multiplier_cannot_fall_back_to_book_default(self):
        with tempfile.TemporaryDirectory() as directory:
            store=CostBasisStore(pathlib.Path(directory)/'ledger.db').initialize()
            book=store.create_book(account='U1111111',symbol='TQQQ',start_date='2026-01-01')
            bid=book['bookId']
            base=dict(account=book['account'],kind='option_trade',right='P',strike=50,
                      expiry='20261218',price=1,cashAmount=100,tradeDate='2026-11-01',contracts=-1,tag='ibkr_open')
            for size in (100,130):store.append_event(bid,dict(base,sharesPerContract=size),client_token=f'open-{size}')
            version=store.ledger_version(bid)
            with self.assertRaises(InvalidRequestError):
                store.append_event(bid,base,client_token='ambiguous-append')
            with self.assertRaises(InvalidRequestError):
                store.import_events(bid,[base],import_batch_id='ambiguous-batch',client_token_prefix='ambiguous-token',
                    book_identity=book,expected_ledger_version=version)
            self.assertEqual(store.ledger_version(bid),version)

    def test_backdated_pair_is_validated_atomically_against_existing_close(self):
        with tempfile.TemporaryDirectory() as directory:
            store=CostBasisStore(pathlib.Path(directory)/'ledger.db').initialize()
            book=store.create_book(account='U1111111',symbol='TQQQ',start_date='2026-01-01')
            bid=book['bookId']
            base=dict(account=book['account'],kind='option_trade',right='P',strike=50,
                      expiry='20261218',sharesPerContract=100,price=1,fees=0)
            def event(day,delta,tag,ref):
                return dict(base,tradeDate=f'2026-11-{day:02}',contracts=delta,
                            cashAmount=-delta*100,tag=tag,externalRef=ref)
            original=[event(1,-2,'ibkr_open','original-open'),event(4,2,'ibkr_close','original-close')]
            store.import_events(bid,original,import_batch_id='original-batch',client_token_prefix='original-token',
                                book_identity=book,expected_ledger_version=store.ledger_version(bid))
            # The first new row alone strands the stored day-4 close, but the
            # second restores its backing before day 4. The batch is one unit.
            extra=[event(2,1,'ibkr_close','extra-close'),event(3,-1,'ibkr_open','extra-open')]
            store.import_events(bid,extra,import_batch_id='extra-batch',client_token_prefix='extra-token',
                                book_identity=book,expected_ledger_version=store.ledger_version(bid))
            self.assertEqual(store.list_events(bid)['total'],4)
            version=store.ledger_version(bid)
            with self.assertRaises(PositionOverdrawError):
                store.import_events(bid,[event(2,2,'ibkr_close','unbacked-close')],import_batch_id='invalid-batch',
                    client_token_prefix='invalid-token',book_identity=book,expected_ledger_version=version)
            self.assertEqual(store.ledger_version(bid),version)

    def test_seeded_cross_layer_histories(self):
        campaign=Campaign()
        try:
            for seed in range(12):
                with self.subTest(seed=seed): campaign.verify_case(seed,steps=36,store=True)
        finally: campaign.close()

if __name__=='__main__':
    unittest.main()
