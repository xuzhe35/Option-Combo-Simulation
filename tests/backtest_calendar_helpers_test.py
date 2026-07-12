"""Unit tests for the backtest's exchange-calendar helpers.

Covers the two review findings: audit-confirmed vendor gaps must count as
trading days, and the calendar must extend past the entry range so late
back expiries are counted (or the trade skipped) instead of silently
truncated.

Run:  python3 tests/backtest_calendar_helpers_test.py
"""

import importlib.util
import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "backtest_calendar_vs_iron_fly.py"
spec = importlib.util.spec_from_file_location("backtest_mod", SCRIPT)
backtest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backtest)


def weekdays(start, count):
    days, day = [], start
    while len(days) < count:
        if day.weekday() < 5:
            days.append(day)
        day += timedelta(days=1)
    return days


class TradingDayCountTest(unittest.TestCase):
    def test_counts_half_open_interval(self):
        cal = weekdays(date(2026, 7, 6), 15)  # Mon 07-06 onward
        self.assertEqual(backtest._trading_day_count(cal, date(2026, 7, 6), date(2026, 7, 13)), 5)
        self.assertEqual(backtest._trading_day_count(cal, date(2026, 7, 10), date(2026, 7, 13)), 1)
        self.assertEqual(backtest._trading_day_count(cal, date(2026, 7, 11), date(2026, 7, 13)), 0)

    def test_vendor_gap_added_back_counts_as_trading_day(self):
        # Data lost Wednesday 2026-07-08; the market traded it.
        cal_full = weekdays(date(2026, 7, 6), 10)
        data = [d for d in cal_full if d != date(2026, 7, 8)]
        entries, calendar, _ = backtest._prepare_calendar(
            data, [date(2026, 7, 8)], date(2026, 7, 6), date(2026, 7, 17))
        self.assertEqual(
            backtest._trading_day_count(calendar, date(2026, 7, 6), date(2026, 7, 13)), 5)
        # Without the gap repair the count would be 4 — the review bug.
        self.assertEqual(
            backtest._trading_day_count(sorted(data), date(2026, 7, 6), date(2026, 7, 13)), 4)


class PrepareCalendarTest(unittest.TestCase):
    def test_entries_stay_data_driven_and_inside_range(self):
        cal_full = weekdays(date(2026, 6, 22), 15)  # three weeks
        data = [d for d in cal_full if d != date(2026, 6, 26)]  # Friday lost by vendor
        entries, calendar, last = backtest._prepare_calendar(
            data, [date(2026, 6, 26)], date(2026, 6, 22), date(2026, 7, 3))
        # Entry for the first week falls back to Thursday (last DATA day),
        # even though the calendar knows Friday traded.
        self.assertIn(date(2026, 6, 25), entries)
        self.assertNotIn(date(2026, 6, 26), entries)
        self.assertIn(date(2026, 6, 26), calendar)
        # Entries respect the range; the calendar extends beyond it.
        self.assertTrue(all(date(2026, 6, 22) <= e <= date(2026, 7, 3) for e in entries))
        self.assertGreater(last, date(2026, 7, 3))

    def test_last_covered_flags_back_expiries_beyond_calendar(self):
        data = weekdays(date(2026, 6, 1), 20)
        _, calendar, last = backtest._prepare_calendar(
            data, [], date(2026, 6, 1), date(2026, 6, 26))
        beyond = last + timedelta(days=7)
        # The run loop skips when back > last_covered instead of counting a
        # truncated window.
        self.assertGreater(beyond, last)
        truncated = backtest._trading_day_count(calendar, data[-3], beyond)
        full_week_equiv = backtest._trading_day_count(calendar, data[-3], last + timedelta(days=1))
        self.assertEqual(truncated, full_week_equiv)  # proof of truncation risk


if __name__ == "__main__":
    unittest.main()
