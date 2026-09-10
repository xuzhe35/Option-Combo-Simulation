"""Execute only the read-only snapshot endpoint with fakes, never boot ib_server."""
import ast
import asyncio
import pathlib
import unittest
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock

from ib_server_market_data import cost_basis_option_identity, cost_basis_option_request_matches


class StressSnapshotTest(unittest.IsolatedAsyncioTestCase):
    def environment(self, positions):
        source = pathlib.Path(__file__).resolve().parents[1] / 'ib_server.py'
        tree = ast.parse(source.read_text())
        function = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef)
                        and n.name == '_request_cost_basis_option_scenario_inputs')
        received = datetime(2026, 9, 8, 16, tzinfo=timezone.utc)
        curve = {'schemaVersion': 2, 'currency': 'USD', 'effectiveDate': '2026-09-08',
                 'points': [{'tenorDays': 30, 'zeroRate': 0.04}]}
        async def snapshots(contracts, **_):
            return [NS(contract=c, time=received, marketDataType=1) for c in contracts]
        env = {
            'datetime': datetime, 'asyncio': asyncio, 'uuid': uuid,
            'ib': NS(isConnected=lambda: True, positions=lambda: positions),
            '_cost_basis_option_identity': cost_basis_option_identity,
            '_cost_basis_option_request_matches': cost_basis_option_request_matches,
            '_cost_basis_stock_snapshot_contract': lambda c, _: c,
            '_cost_basis_option_snapshot_contract': lambda c, _: c,
            '_cost_basis_underlying_contracts': {},
            '_request_cost_basis_snapshot_tickers': AsyncMock(side_effect=snapshots),
            '_get_discount_curve_snapshot': AsyncMock(return_value={'curve': curve, 'status': 'ready'}),
            'extract_market_price': lambda _: 100,
            'extract_quote_snapshot': lambda *_: {'mark': 5, 'bid': 4.9, 'ask': 5.1, 'bidAskValid': True},
            'extract_option_iv': lambda _: 0.3,
            '_cost_basis_option_iv_source': lambda _: 'modelGreeks',
            'build_scenario_rates_by_expiry': lambda *_: [],
            'resolve_snapshot_discount': None,
            'option_contract_timing_by_con_id': {2: {'expiryAsOf': '2026-09-09T20:15:00Z'}},
        }
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), env)
        return env, curve, received

    def positions(self):
        def contract(sec_type, currency, con_id):
            return NS(secType=sec_type, symbol='QQQ', currency=currency, conId=con_id,
                      right='P', strike=100, lastTradeDateOrContractMonth='20260909',
                      multiplier='100', localSymbol=f'QQQ-{con_id}')
        return [NS(account='U1', position=1, contract=contract('STK', 'USD', 1)),
                NS(account='U1', position=1, contract=contract('OPT', 'USD', 2)),
                NS(account='U1', position=1, contract=contract('OPT', 'CAD', 3))]

    async def test_currency_scoping_and_snapshot_provenance(self):
        env, curve, received = self.environment(self.positions())
        result = await env['_request_cost_basis_option_scenario_inputs']({
            'account': 'U1', 'symbol': 'QQQ', 'currency': 'USD', 'throughExpiry': '20260909',
            'contracts': [{'conId': 2}, {'conId': 3}]})
        self.assertEqual([r['conId'] for r in result['options']], [2])
        self.assertEqual(result['snapshotVersion'], 2)
        self.assertEqual(result['discountCurve'], curve)
        self.assertTrue(result['snapshotId'])
        self.assertEqual(result['underlyingObservedAt'], received.isoformat())
        self.assertEqual(result['options'][0]['observedAt'], received.isoformat())
        self.assertEqual(result['options'][0]['expiryAsOf'], '2026-09-09T20:15:00Z')
        self.assertEqual(result['options'][0]['currency'], 'USD')

    async def test_non_usd_fails_before_any_market_request(self):
        env, _, _ = self.environment(self.positions())
        with self.assertRaisesRegex(ValueError, 'USD'):
            await env['_request_cost_basis_option_scenario_inputs']({
                'account': 'U1', 'symbol': 'QQQ', 'currency': 'CAD', 'throughExpiry': '20260909'})
        env['_request_cost_basis_snapshot_tickers'].assert_not_called()

    async def test_cancelled_no_data_fetch_cleans_only_its_own_broker_lines(self):
        # Exercise the production fetcher's finally block without booting IB.
        source = pathlib.Path(__file__).resolve().parents[1] / 'ib_server.py'
        tree = ast.parse(source.read_text())
        function = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef)
                        and n.name == '_request_cost_basis_snapshot_tickers')

        class Event:
            def __init__(self): self.handlers = []
            def __iadd__(self, handler): self.handlers.append(handler); return self
            def __isub__(self, handler): self.handlers.remove(handler); return self

        class Ticker:
            def __init__(self, contract, **kwargs): self.contract = contract

        request_ids = iter([1, 2])
        opened, cancelled = [], []
        wrapper = NS(defaults={}, reqId2Ticker={999: 'existing workspace ticker'},
                     _reqId2Contract={999: 'existing workspace contract'},
                     ticker2ReqId=defaultdict(dict))
        wrapper.endTicker = lambda ticker, key: wrapper.ticker2ReqId[key].pop(ticker, None)
        ib = NS(wrapper=wrapper, pendingTickersEvent=Event(), client=NS(
            getReqId=lambda: next(request_ids),
            reqMktData=lambda *args: opened.append(args[0]),
            cancelMktData=lambda req_id: cancelled.append(req_id)))
        env = {'asyncio': asyncio, 'uuid': uuid, 'ib': ib, 'Ticker': Ticker,
               'COST_BASIS_SNAPSHOT_BATCH_SIZE': 20,
               'chunked': lambda items, size: [items],
               '_positive_contract_id': lambda value: value,
               'cost_basis_batch_complete': lambda *args: False}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), env)
        task = asyncio.create_task(env['_request_cost_basis_snapshot_tickers']([
            NS(secType='STK', conId=1), NS(secType='OPT', conId=2)]))
        await asyncio.sleep(0)
        self.assertEqual(opened, [1, 2])
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(cancelled, [1, 2])
        self.assertEqual(wrapper.reqId2Ticker, {999: 'existing workspace ticker'})
        self.assertEqual(wrapper._reqId2Contract, {999: 'existing workspace contract'})
        self.assertEqual(dict(wrapper.ticker2ReqId), {})
        self.assertEqual(ib.pendingTickersEvent.handlers, [])


if __name__ == '__main__':
    unittest.main()
