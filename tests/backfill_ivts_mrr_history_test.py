"""Regression tests for official weekly-close MRR backfill selection."""

import importlib.util
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "backfill_ivts_mrr_history.py"
SPEC = importlib.util.spec_from_file_location("backfill_ivts_mrr_history", SCRIPT)
BACKFILL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BACKFILL)


def _calendar(fetched_at):
    return {
        "calendarKey": "NYSE",
        "sourceKind": "official_html",
        "sourceUrl": "https://www.nyse.com/trade/hours-calendars",
        "sourceSha256": "a" * 64,
        "fetchedAt": fetched_at.isoformat(),
        "coverageStart": "2026-06-22",
        "coverageEnd": "2026-07-17",
        "closures": [{"date": "2026-07-03", "status": "closed"}],
        "earlyCloses": [],
    }


class BackfillWeeklyEntryTest(unittest.TestCase):
    def _records(self, dates, now, gaps=()):
        def fake_get(path, _params):
            if path == "/v1/trading-dates":
                return {"dates": dates}
            if path == "/v1/audit/missing-dates":
                return {"missingDates": [{"quoteDate": value} for value in gaps]}
            raise AssertionError(path)

        with mock.patch.object(BACKFILL, "_get", side_effect=fake_get):
            return BACKFILL._validated_weekly_entries(
                "SPY", now=now, official_calendar=_calendar(now)
            )

    def test_partial_database_tail_does_not_turn_monday_into_week_close(self):
        records = self._records(
            ["2026-06-26", "2026-06-29"],
            datetime(2026, 7, 6, tzinfo=timezone.utc),
        )
        self.assertEqual([record["date"].isoformat() for record in records], ["2026-06-26"])

    def test_missing_official_final_session_skips_instead_of_shifting_earlier(self):
        records = self._records(
            ["2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09"],
            datetime(2026, 7, 13, tzinfo=timezone.utc),
            gaps=["2026-07-10"],
        )
        self.assertEqual(records, [])

    def test_current_final_session_is_accepted_only_after_close(self):
        before = self._records(
            ["2026-07-17"],
            datetime(2026, 7, 17, 20, 14, tzinfo=timezone.utc),
        )
        after = self._records(
            ["2026-07-17"],
            datetime(2026, 7, 17, 20, 15, tzinfo=timezone.utc),
        )
        self.assertEqual(before, [])
        self.assertEqual([record["date"].isoformat() for record in after], ["2026-07-17"])

    def test_stale_or_untrusted_official_calendar_fails_closed(self):
        now = datetime(2026, 7, 17, 20, 15, tzinfo=timezone.utc)
        stale = _calendar(datetime(2026, 7, 1, tzinfo=timezone.utc))
        untrusted = _calendar(now)
        untrusted["sourceKind"] = "hand_written"
        with mock.patch.object(BACKFILL, "_get") as mocked_get:
            with self.assertRaisesRegex(RuntimeError, "stale"):
                BACKFILL._validated_weekly_entries("SPY", now=now, official_calendar=stale)
            with self.assertRaisesRegex(RuntimeError, "official_html"):
                BACKFILL._validated_weekly_entries("SPY", now=now, official_calendar=untrusted)
        mocked_get.assert_not_called()


if __name__ == "__main__":
    unittest.main()
