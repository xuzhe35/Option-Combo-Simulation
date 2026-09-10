"""Run after verify_page.js. Real store, temporary databases only.
Assertions describe observed remaining failures as well as repaired paths.
"""
import json
import pathlib
import sys
import tempfile
import uuid
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3]))
from cost_basis_store import CostBasisStore, ImportRevisionConflictError, ResetConfirmationError

fixtures = json.loads(pathlib.Path(sys.argv[1] if len(sys.argv)>1 else '/tmp/cb_fix_fixtures.json').read_text())
def token(): return uuid.uuid4().hex
def event(e):
    return {k:v for k,v in e.items() if k not in ('eventId','seq','sourceRef','sourceLegs','fills','fillOf','priceText','lineNumber','currency','cashDerived','unpaired')}
def registration(month=9):
    return dict(format='activity', account='U1111111', periodFrom=f'2026-{month:02d}-01', periodThrough=f'2026-{month:02d}-{31 if month==8 else 30}', checks={'trades':True, 'closingPositions':True})
def make(root):
    s=CostBasisStore(pathlib.Path(root)/'ledger.db').initialize()
    b=s.create_book(account='U1111111',symbol='TQQQ',start_date='2026-01-01')
    return s,b
observed={}
for name,f in fixtures.items():
    if f['problems']: continue  # A blocked preview must not be forced through the store.
    with tempfile.TemporaryDirectory() as root:
        s,b=make(root); bid=b['bookId']; ids={}
        for old in f['existing']:
            result=s.append_event(bid,event(old),client_token=token())
            ids[old['eventId']]=result['event']['eventId']
        try:
            result=s.import_events(bid,[event(e) for e in f['incoming']],
                import_batch_id=token(),client_token_prefix=token(),
                expected_ledger_version=s.ledger_version(bid),book_identity=b,
                supersede_prior_stub_event_ids=[ids[i] for i in f['supersedePriorStubEventIds']],
                statement=registration())
            rows=s.list_events(bid)['events']
            out={'inserted':result['inserted'], 'activeRows':len(rows),
                 'shares':sum(e.get('shares') or 0 for e in rows),
                 'contracts':sum(e.get('contracts') or 0 for e in rows),
                 'cash':sum(e.get('cashAmount') or 0 for e in rows),
                 'supersededPriorStubs':result.get('supersededPriorStubs',0)}
        except Exception as exc:
            out={'error':type(exc).__name__,'message':str(exc)}
        observed[name]=out
        print(name,json.dumps(out))
assert observed['QUANTITY_REVISION']['shares']==30
assert observed['DATE_ONLY_TWIN']['shares']==20
assert observed['FLEX_PRIOR_STUB']['contracts']==-2
assert observed['FIXED_ACTIVITY_STUB']['contracts']==-1
assert observed['FIXED_ACTIVITY_STUB']['supersededPriorStubs']==1
assert observed['SAME_REF_REVISION']['cash']==-501
assert observed['DIRECT_EXEC_REVISION']['shares']==10
assert observed['REUSED_CROSS_FORMAT_TWIN']['shares']==10
assert observed['ORDER_FILL_CASH_MISMATCH']['cash']==-1012
assert observed['NO_TRADE_INITIAL_HOLDING']['error']=='InvalidRequestError'
assert observed['FIXED_CASH_SIGNS']['cash']==-7
assert observed['MANUAL_ASSIGNMENT_TWIN']['shares']==200
assert observed['MANUAL_ASSIGNMENT_TWIN']['cash']==-9600

with tempfile.TemporaryDirectory() as root:
    s,b=make(root);bid=b['bookId']
    old=event(fixtures['SAME_REF_REVISION']['existing'][0])
    s.import_events(bid,[old],import_batch_id=token(),client_token_prefix=token(),statement=registration(8))
    corrected=dict(old,price=51,cashAmount=-511)
    try:
        s.import_events(bid,[corrected],import_batch_id=token(),client_token_prefix=token(),expected_ledger_version=s.ledger_version(bid),book_identity=b)
        raise AssertionError('same-ref correction should be blocked if it reaches the store')
    except ImportRevisionConflictError:
        print('FIXED_SERVER_SAME_REF_CHECK blocked as expected')
    plan=s.reset_confirmation(bid)
    replacement=dict(old,externalRef='new-history',cashAmount=-521,price=52)
    s.rebuild_book(bid,[replacement],confirmation=plan['phrase'],client_token=token(),import_batch_id=token(),expected_ledger_version=plan['ledgerVersion'],book_identity=b,statement=registration(9))
    try:
        s.rebuild_book(bid,[old],confirmation=plan['phrase'],client_token=token(),import_batch_id=token(),expected_ledger_version=plan['ledgerVersion'],book_identity=b)
        raise AssertionError('stale digest should be blocked')
    except ResetConfirmationError:
        print('FIXED_REBUILD_STALE_DIGEST blocked as expected')
    batches=s.list_import_batches(bid)
    assert any(e['periodFrom']=='2026-08-01' for e in batches)
    assert any(e['periodFrom']=='2026-09-01' for e in batches)
    output=pathlib.Path(sys.argv[2] if len(sys.argv)>2 else '/tmp/cb_fix_coverage.json')
    output.write_text(json.dumps(batches,indent=2))
    print('COVERAGE_AFTER_REBUILD',json.dumps({'activeRows':s.list_events(bid)['total'],'periods':[(x['periodFrom'],x['periodThrough']) for x in batches]}))
    result=s.rebuild_book(bid,[old],confirmation=plan['phrase'],client_token=token(),import_batch_id=token(),book_identity=b)
    assert result['inserted']==1
    print('MISSING_REBUILD_DIGEST same-count stale phrase still accepted')
print('Observed-state store assertions passed; real user databases were never opened.')
