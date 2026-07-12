import importlib.util
import datetime as dt
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "sync_official_exchange_calendars.py"
spec = importlib.util.spec_from_file_location("official_calendar_sync", SCRIPT)
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class NyseParserTest(unittest.TestCase):
    def test_parses_official_table_and_early_closes(self):
        page = b"""
        <table><thead><tr><th>Holiday</th><th>2026</th><th>2027</th></tr></thead>
        <tbody>
          <tr><th>New Year's Day</th><td>Thursday, January 1</td><td>Friday, January 1</td></tr>
          <tr><th>MLK Day</th><td>Monday, January 19</td><td>Monday, January 18</td></tr>
          <tr><th>Presidents</th><td>Monday, February 16</td><td>Monday, February 15</td></tr>
          <tr><th>Good Friday</th><td>Friday, April 3</td><td>Friday, March 26</td></tr>
          <tr><th>Memorial</th><td>Monday, May 25</td><td>Monday, May 31</td></tr>
          <tr><th>Juneteenth</th><td>Friday, June 19</td><td>Friday, June 18</td></tr>
          <tr><th>Independence</th><td>Friday, July 3</td><td>Monday, July 5</td></tr>
          <tr><th>Labor</th><td>Monday, September 7</td><td>Monday, September 6</td></tr>
          <tr><th>Thanksgiving</th><td>Thursday, November 26</td><td>Thursday, November 25</td></tr>
          <tr><th>Christmas</th><td>Friday, December 25</td><td>Friday, December 24</td></tr>
        </tbody></table>
        <p>Each market will close early at 1:00 p.m. (1:15 p.m. for eligible options)
        on Friday, November 27, 2026. All times are Eastern Time.</p>
        """
        result = sync.parse_nyse_calendar(page, "2026-07-12T00:00:00+00:00")
        self.assertEqual(result["coverageStart"], "2026-01-01")
        self.assertEqual(result["coverageEnd"], "2027-12-31")
        self.assertIn("2026-07-03", [item["date"] for item in result["closures"]])
        self.assertEqual(result["earlyCloses"][0]["date"], "2026-11-27")


class CmeParserTest(unittest.TestCase):
    def test_normalizes_observed_cme_trading_date_formats(self):
        self.assertEqual(sync._normalize_cme_date("07-09-25"), "2025-07-09")
        self.assertEqual(sync._normalize_cme_date("070926"), "2026-07-09")
        self.assertEqual(sync._normalize_cme_date("2027-07-09"), "2027-07-09")
        self.assertEqual(sync._normalize_cme_date("07/09/2028"), "2028-07-09")

    def test_maps_product_group_to_product_specific_schedule(self):
        products = {"records": [
            {"globexProductCode": code, "globexGroupCode": f"G-{code}"}
            for code in sorted(set(sync.CME_PRODUCTS.values()))
        ]}
        schedules = {"records": [
            {
                "applicableGlobexGroupCodes": [f"G-{code}"],
                "marketEventsByDate": [
                    {"tradingDate": "07-02-26", "marketEvents": [
                        {"marketEventType": "open", "marketEventTime": "02072026-22:00:00.000Z"},
                        {"marketEventType": "closed", "marketEventTime": "03072026-21:00:00.000Z"},
                    ]},
                    {"tradingDate": "07-06-26", "marketEvents": [
                        {"marketEventType": "open", "marketEventTime": "05072026-22:00:00.000Z"},
                        {"marketEventType": "closed", "marketEventTime": "03072026-21:00:00.000Z"},
                    ]},
                ],
            }
            for code in sorted(set(sync.CME_PRODUCTS.values()))
        ]}
        result = sync.parse_cme_calendars(products, schedules, "2026-07-12T00:00:00+00:00")
        self.assertIn("CME:ES", result)
        self.assertIn("NYMEX:CL", result)
        self.assertEqual(result["CME:ES"]["closures"][0]["date"], "2026-07-03")
        self.assertEqual(
            result["CME:ES"]["closures"][0]["reason"],
            "missing_business_trade_date",
        )
        self.assertEqual(result["CME:ES"]["coverageStart"], "2026-07-02")
        self.assertEqual(result["CME:ES"]["coverageEnd"], "2026-07-06")
        self.assertEqual(
            result["CME:ES"]["derivationVersion"],
            sync.CME_DERIVATION_VERSION,
        )

    def test_rejects_implausible_long_schedule_with_zero_closures(self):
        products = {"records": [
            {"globexProductCode": code, "globexGroupCode": f"G-{code}"}
            for code in sorted(set(sync.CME_PRODUCTS.values()))
        ]}
        start = dt.date(2026, 1, 1)
        end = dt.date(2027, 1, 1)
        entries = []
        current = start
        while current <= end:
            if current.weekday() < 5:
                entries.append({
                    "tradingDate": current.strftime("%m-%d-%y"),
                    "marketEvents": [{"marketEventType": "open"}],
                })
            current += dt.timedelta(days=1)
        schedules = {"records": [
            {
                "applicableGlobexGroupCodes": [f"G-{code}"],
                "marketEventsByDate": entries,
            }
            for code in sorted(set(sync.CME_PRODUCTS.values()))
        ]}
        with self.assertRaisesRegex(sync.CalendarSyncError, "zero closures"):
            sync.parse_cme_calendars(
                products, schedules, "2026-07-12T00:00:00+00:00")


if __name__ == "__main__":
    unittest.main()
