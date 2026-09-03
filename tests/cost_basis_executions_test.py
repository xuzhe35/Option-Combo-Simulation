import datetime
import types
import unittest
from zoneinfo import ZoneInfo

from cost_basis_executions import (
    execution_filter_time,
    serialize_fill,
    serialize_fills,
)


def _fill(*, exec_id='E1', account='U1', symbol='TQQQ', sec_type='OPT',
          side='SLD', quantity=2, price=1.25, commission=1.4,
          currency='USD'):
    contract = types.SimpleNamespace(
        secType=sec_type, symbol=symbol, conId=123, localSymbol='TQQQ  260902P00071000',
        lastTradeDateOrContractMonth='20260902', right='P', strike=71,
        multiplier='100')
    execution = types.SimpleNamespace(
        execId=exec_id, acctNumber=account, side=side, shares=quantity,
        price=price, time=datetime.datetime(2026, 9, 1, 10, 15, 20),
        permId=9, orderId=10, orderRef='ledger')
    report = types.SimpleNamespace(
        commission=commission, currency=currency, realizedPNL=0)
    return types.SimpleNamespace(
        contract=contract, execution=execution, commissionReport=report,
        time=execution.time)


class CostBasisExecutionSerializationTests(unittest.TestCase):
    def test_serializes_a_leg_with_exact_broker_identity(self):
        row, reason = serialize_fill(_fill())
        self.assertEqual(reason, '')
        self.assertEqual(row['execId'], 'E1')
        self.assertEqual(row['brokerTimestamp'], '2026-09-01T10:15:20')
        self.assertEqual(row['commission'], 1.4)
        self.assertTrue(row['commissionAvailable'])

    def test_bag_summary_is_excluded_to_avoid_double_counting(self):
        row, reason = serialize_fill(_fill(sec_type='BAG'))
        self.assertIsNone(row)
        self.assertEqual(reason, 'bag_summary')

    def test_filters_scope_and_deduplicates_exec_ids(self):
        result = serialize_fills([
            _fill(exec_id='E1'),
            _fill(exec_id='E1'),
            _fill(exec_id='E2', account='U2'),
            _fill(exec_id='E3', symbol='SPY'),
        ], account='U1', symbol='TQQQ')
        self.assertEqual([row['execId'] for row in result['executions']], ['E1'])
        self.assertEqual(result['ignored']['duplicate_exec_id'], 1)
        self.assertEqual(result['ignored']['other_account'], 1)
        self.assertEqual(result['ignored']['other_symbol'], 1)

    def test_missing_commission_is_explicit(self):
        row, _ = serialize_fill(_fill(commission=0, currency=''))
        self.assertFalse(row['commissionAvailable'])

    def test_negative_commission_keeps_its_rebate_sign(self):
        row, _ = serialize_fill(_fill(commission=-0.18))
        self.assertEqual(row['commission'], -0.18)

    def test_cached_commission_does_not_replace_fresh_execution_time(self):
        queried = _fill(commission=None, currency='')
        queried.execution.time = datetime.datetime(
            2026, 9, 2, 1, 30, 0, tzinfo=datetime.timezone.utc)
        cached_report = types.SimpleNamespace(
            commission=1.25, currency='USD', realizedPNL=260.5)

        result = serialize_fills(
            [queried],
            target_timezone=ZoneInfo('America/New_York'),
            commission_reports_by_exec_id={'E1': cached_report},
        )

        row = result['executions'][0]
        self.assertEqual(row['brokerTimestamp'], '2026-09-01T21:30:00')
        self.assertEqual(row['commission'], 1.25)
        self.assertEqual(row['realizedPnl'], 260.5)

    def test_aware_utc_execution_is_rendered_in_tws_timezone(self):
        fill = _fill()
        fill.execution.time = datetime.datetime(
            2026, 9, 1, 14, 15, 20, tzinfo=datetime.timezone.utc)
        row, _ = serialize_fill(
            fill, target_timezone=ZoneInfo('America/New_York'))
        self.assertEqual(row['brokerTimestamp'], '2026-09-01T10:15:20')

    def test_utc_date_rollover_returns_previous_tws_trade_date(self):
        fill = _fill()
        fill.execution.time = datetime.datetime(
            2026, 9, 2, 1, 30, 0, tzinfo=datetime.timezone.utc)
        row, _ = serialize_fill(
            fill, target_timezone=ZoneInfo('America/New_York'))
        self.assertEqual(row['brokerTimestamp'], '2026-09-01T21:30:00')

    def test_aware_execution_without_broker_timezone_fails_closed(self):
        fill = _fill()
        fill.execution.time = datetime.datetime(
            2026, 9, 1, 14, 15, 20, tzinfo=datetime.timezone.utc)
        row, _ = serialize_fill(fill)
        self.assertEqual(row['brokerTimestamp'], '')

    def test_filter_fallback_uses_broker_midnight(self):
        broker_now = datetime.datetime(
            2026, 9, 1, 23, 30, tzinfo=ZoneInfo('America/New_York'))
        self.assertEqual(
            execution_filter_time('', broker_now), '20260901-00:00:00')

    def test_csv_filter_keeps_broker_local_cutoff(self):
        broker_now = datetime.datetime(
            2026, 9, 2, 1, 0, tzinfo=ZoneInfo('America/New_York'))
        self.assertEqual(
            execution_filter_time('2026-09-01T21:30:00', broker_now),
            '20260901-21:30:00')


if __name__ == '__main__':
    unittest.main()
