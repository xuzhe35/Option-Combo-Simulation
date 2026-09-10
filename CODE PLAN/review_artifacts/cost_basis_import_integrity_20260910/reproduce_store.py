import sys, json, tempfile, pathlib, uuid, subprocess
ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from cost_basis_store import CostBasisStore

with tempfile.TemporaryDirectory() as fixture_dir:
    fixture_path = pathlib.Path(fixture_dir) / 'fixtures.json'
    subprocess.run(['node', str(pathlib.Path(__file__).with_name('reproduce_parser.js')), str(fixture_path)], check=True)
    fixtures = json.loads(fixture_path.read_text())
def token(): return uuid.uuid4().hex
for name, fixture in fixtures.items():
    with tempfile.TemporaryDirectory() as folder:
        store=CostBasisStore(pathlib.Path(folder)/'review.db').initialize()
        book=store.create_book(account='U1111111',symbol=fixture.get('symbol','TQQQ'),sec_type=fixture.get('secType','STK'),start_date='2026-01-01')
        bid=book['bookId']
        def imp(events):
            return store.import_events(bid,events,import_batch_id=token(),client_token_prefix=token())
        try:
            if fixture['existing']: imp(fixture['existing'])
            result=imp(fixture['incoming'])
            rows=store.list_events(bid)['events']
            print(name,json.dumps({'inserted':result['inserted'],'skipped':result['skipped'],
                'rows':len(rows),'shares':sum(e.get('shares') or 0 for e in rows),
                'contracts':sum(e.get('contracts') or 0 for e in rows),
                'cash':sum(e.get('cashAmount') or 0 for e in rows)}))
        except Exception as e: print(name,type(e).__name__,str(e))

# Two rebuilds with the same row count accept an obsolete plan.
with tempfile.TemporaryDirectory() as folder:
    store=CostBasisStore(pathlib.Path(folder)/'review.db').initialize()
    bid=store.create_book(account='U1111111',symbol='TQQQ',start_date='2026-01-01')['bookId']
    e={'kind':'share_trade','tradeDate':'2026-09-01','account':'U1111111','shares':1,'price':10,'fees':0,'cashAmount':-10}
    store.append_event(bid,e,client_token=token())
    old=store.reset_confirmation(bid)
    store.rebuild_book(bid,[dict(e,price=20,cashAmount=-20)],confirmation=old['phrase'],client_token=token(),import_batch_id=token())
    result=store.rebuild_book(bid,[dict(e,price=30,cashAmount=-30)],confirmation=old['phrase'],client_token=token(),import_batch_id=token())
    print('STALE_RESET_PLAN_ACCEPTED',json.dumps({'oldPhrase':old['phrase'],'inserted':result['inserted']}))
