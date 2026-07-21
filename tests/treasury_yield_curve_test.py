"""Tests for the shared official Treasury par-yield provider.

Run: python3 tests/treasury_yield_curve_test.py
"""

import math
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import treasury_yield_curve as treasury_module
from treasury_yield_curve import (
    TREASURY_CURVE_SOURCE,
    TreasuryYieldCurveError,
    TreasuryYieldCurveProvider,
    normalize_tenor,
    par_yield_to_continuous_proxy,
    parse_treasury_xml,
    tenor_days,
)


def build_xml(rows):
    entries = []
    for row in rows:
        fields = ["<d:NEW_DATE m:type=\"Edm.DateTime\">{}T00:00:00</d:NEW_DATE>".format(row["date"])]
        for name, value in row.get("fields", {}).items():
            if value is None:
                continue
            fields.append("<d:{} m:type=\"Edm.Double\">{}</d:{}>".format(name, value, name))
        entries.append(
            "<entry><content type=\"application/xml\"><m:properties>{}</m:properties>"
            "</content></entry>".format("".join(fields))
        )
    return (
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
        "<feed xmlns=\"http://www.w3.org/2005/Atom\" "
        "xmlns:d=\"http://schemas.microsoft.com/ado/2007/08/dataservices\" "
        "xmlns:m=\"http://schemas.microsoft.com/ado/2007/08/dataservices/metadata\">"
        + "".join(entries)
        + "</feed>"
    ).encode("utf-8")


BASE_XML = build_xml([
    {
        "date": "2026-07-17",
        "fields": {
            "BC_1MONTH": "4.00",
            "BC_1_5MONTH": "4.05",
            "BC_3MONTH": "4.10",
            "BC_1YEAR": "4.20",
        },
    },
    {
        "date": "2026-07-20",
        "fields": {
            "BC_1MONTH": "4.01",
            "BC_1_5MONTH": "4.06",
            "BC_3MONTH": "4.11",
            "BC_1YEAR": "4.21",
        },
    },
])


class TreasuryXmlTest(unittest.TestCase):
    def test_tenor_normalization_includes_new_six_week_series(self):
        self.assertEqual(normalize_tenor(" 6 WK "), "1.5m")
        self.assertEqual(normalize_tenor("10YR"), "10y")
        self.assertEqual(tenor_days("1.5m"), 46)
        with self.assertRaises(ValueError):
            normalize_tenor("18m")

    def test_parse_official_atom_shape_and_decimal_units(self):
        observations = parse_treasury_xml(BASE_XML)
        self.assertEqual([row["date"] for row in observations], ["2026-07-17", "2026-07-20"])
        first = observations[0]
        self.assertEqual([point["tenorCode"] for point in first["points"]], ["1m", "1.5m", "3m", "1y"])
        self.assertEqual(first["points"][1]["officialField"], "BC_1_5MONTH")
        self.assertAlmostEqual(first["points"][2]["parYield"], 0.041)

    def test_invalid_xml_is_a_provider_error(self):
        with self.assertRaises(TreasuryYieldCurveError):
            parse_treasury_xml(b"not xml")


class TreasuryProviderTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tmpdir.name) / "rates.db")

    def tearDown(self):
        self.tmpdir.cleanup()

    def provider(self, payload=BASE_XML):
        return TreasuryYieldCurveProvider(self.db_path, fetch_year=lambda _year: payload)

    def test_atomic_refresh_and_latest_on_or_before(self):
        provider = self.provider()
        result = provider.refresh("2026-07-17", "2026-07-20")
        self.assertTrue(result["cacheIsAtomic"])
        self.assertEqual(result["observationCount"], 2)
        self.assertEqual(result["proxyUpsertCount"], 2)

        weekend = provider.get_curve_snapshot("2026-07-19")
        self.assertEqual(weekend["schemaVersion"], 1)
        self.assertEqual(weekend["kind"], "treasury_discount_curve")
        self.assertEqual(weekend["effectiveDate"], "2026-07-17")
        self.assertEqual(weekend["requestedDate"], "2026-07-19")
        self.assertFalse(weekend["curveSemantics"]["officialZeroCouponCurve"])
        self.assertTrue(weekend["curveSemantics"]["discountingIsApproximate"])
        self.assertEqual(
            weekend["discountRateSemantics"],
            "continuous_zero_proxy_from_cmt_par_yield",
        )
        self.assertTrue(weekend["points"][0]["continuousRateIsProxy"])
        self.assertEqual(weekend["quality"]["status"], "degraded")
        self.assertTrue(weekend["snapshotId"].startswith("treasury:2026-07-17:"))
        self.assertEqual(weekend["quoteAsOf"], "2026-07-17T19:30:00Z")
        self.assertAlmostEqual(
            weekend["points"][0]["continuousRate"],
            par_yield_to_continuous_proxy(0.04),
        )
        self.assertIsNone(provider.get_curve_snapshot("2026-07-16"))

        conn = sqlite3.connect(self.db_path)
        try:
            proxy = conn.execute(
                """
                SELECT rf.rate, rf.source
                FROM risk_free_daily_rates rf JOIN dates d ON d.date_id = rf.date_ref
                WHERE d.date = '2026-07-17'
                """
            ).fetchone()
        finally:
            conn.close()
        self.assertEqual(proxy[1], TREASURY_CURVE_SOURCE + ":3m")
        self.assertAlmostEqual(proxy[0], 0.041)

    def test_download_failure_cannot_partially_overwrite_cache(self):
        provider = self.provider()
        provider.refresh("2026-07-17", "2026-07-17")

        changed_2026 = build_xml([{
            "date": "2026-07-17",
            "fields": {"BC_1MONTH": "9.99", "BC_3MONTH": "9.99"},
        }])

        def fail_second_year(year):
            if year == 2026:
                return changed_2026
            raise TreasuryYieldCurveError("offline")

        provider._fetch_year = fail_second_year
        with self.assertRaises(TreasuryYieldCurveError):
            provider.refresh("2025-12-31", "2026-07-17")
        unchanged = provider.get_curve_snapshot("2026-07-17")
        self.assertAlmostEqual(unchanged["points"][0]["parYield"], 0.04)

    def test_discount_quote_is_explicit_par_as_zero_proxy(self):
        provider = self.provider()
        provider.refresh("2026-07-17", "2026-07-17")
        quote = provider.get_discount_quote(60, "2026-07-19")
        self.assertEqual(quote["effectiveDate"], "2026-07-17")
        self.assertEqual(quote["interpolation"], "linear_continuous_rate")
        self.assertTrue(quote["approximate"])
        self.assertFalse(quote["fallbackUsed"])
        self.assertGreater(quote["discountFactor"], 0)
        self.assertLess(quote["discountFactor"], 1)
        self.assertAlmostEqual(
            quote["discountFactor"],
            math.exp(-quote["continuousRate"] * (60 / 365)),
        )

        short = provider.get_discount_quote(1, "2026-07-19")
        self.assertTrue(short["extrapolated"])
        self.assertEqual(short["lowerPoint"]["tenorCode"], "1m")

    def test_explicit_fallback_is_never_mislabeled_as_treasury(self):
        quote = self.provider().get_discount_quote(
            7,
            "2026-01-01",
            fallback_continuous_rate=0.03,
        )
        self.assertTrue(quote["fallbackUsed"])
        self.assertEqual(quote["source"], "explicit_fallback_continuous_rate")
        self.assertEqual(quote["continuousRate"], 0.03)

    def test_windows_without_iana_tzdata_uses_verified_eastern_fallback(self):
        provider = self.provider()
        provider.refresh("2026-07-17", "2026-07-17")
        with mock.patch.object(treasury_module, "_NEW_YORK", None):
            snapshot = provider.get_curve_snapshot("2026-07-17")
            self.assertEqual(snapshot["quoteAsOf"], "2026-07-17T19:30:00Z")

    def test_refresh_or_cached_reports_feed_failure(self):
        provider = self.provider()
        provider.refresh("2026-07-17", "2026-07-17")
        provider._fetch_year = lambda _year: (_ for _ in ()).throw(
            TreasuryYieldCurveError("network down")
        )
        result = provider.refresh_or_cached(
            "2026-07-17",
            "2026-07-20",
            requested_date="2026-07-20",
        )
        self.assertEqual(result["status"], "cache_fallback")
        self.assertTrue(result["fallbackUsed"])
        self.assertEqual(result["snapshot"]["effectiveDate"], "2026-07-17")


class RefreshGateTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tmpdir.name) / "rates.db")
        self.calls = []

        initial = build_xml([{
            "date": "2026-01-02",
            "fields": {"BC_1MONTH": "4.00", "BC_3MONTH": "4.10"},
        }])
        TreasuryYieldCurveProvider(
            self.db_path, fetch_year=lambda _year: initial
        ).refresh("2026-01-02", "2026-01-02")

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_at_most_one_attempt_per_eastern_date(self):
        refreshed = build_xml([{
            "date": "2026-01-05",
            "fields": {"BC_1MONTH": "4.01", "BC_3MONTH": "4.11"},
        }])

        def fetch(year):
            self.calls.append(year)
            return refreshed

        provider = TreasuryYieldCurveProvider(self.db_path, fetch_year=fetch)
        # 23:30 UTC is 18:30 America/New_York in January.
        now = datetime(2026, 1, 5, 23, 30, tzinfo=timezone.utc)
        first = provider.refresh_latest_if_due(now=now)
        second = provider.refresh_latest_if_due(now=now)
        self.assertEqual(first["status"], "refreshed")
        self.assertIn(second["status"], ("not_due", "already_attempted"))
        self.assertEqual(self.calls, [2026])
        self.assertEqual(first["snapshot"]["effectiveDate"], "2026-01-05")

    def test_existing_cache_waits_until_treasury_publication_hour(self):
        provider = TreasuryYieldCurveProvider(
            self.db_path,
            fetch_year=lambda year: self.calls.append(year) or BASE_XML,
        )
        now = datetime(2026, 1, 5, 16, 0, tzinfo=timezone.utc)  # 11:00 ET
        result = provider.refresh_latest_if_due(now=now)
        self.assertEqual(result["status"], "not_due")
        self.assertFalse(result["refreshAttempted"])
        self.assertEqual(self.calls, [])

    def test_failed_attempt_returns_cache_and_is_not_retried_same_day(self):
        def fail(_year):
            self.calls.append("failed")
            raise TreasuryYieldCurveError("offline")

        provider = TreasuryYieldCurveProvider(self.db_path, fetch_year=fail)
        now = datetime(2026, 1, 5, 23, 30, tzinfo=timezone.utc)
        first = provider.refresh_latest_if_due(now=now)
        second = provider.refresh_latest_if_due(now=now)
        self.assertEqual(first["status"], "cache_fallback")
        self.assertTrue(first["fallbackUsed"])
        self.assertEqual(second["status"], "not_due")
        self.assertEqual(self.calls, ["failed"])

    def test_stale_prepublication_bootstrap_does_not_block_postpublication_refresh(self):
        refreshed = build_xml([{
            "date": "2026-01-12",
            "fields": {"BC_1MONTH": "4.02", "BC_3MONTH": "4.12"},
        }])

        def fetch(year):
            self.calls.append(year)
            return refreshed

        provider = TreasuryYieldCurveProvider(self.db_path, fetch_year=fetch)
        before_publication = datetime(2026, 1, 12, 16, 0, tzinfo=timezone.utc)  # 11:00 ET
        after_publication = datetime(2026, 1, 12, 23, 30, tzinfo=timezone.utc)  # 18:30 ET

        bootstrap = provider.refresh_latest_if_due(now=before_publication)
        published = provider.refresh_latest_if_due(now=after_publication)
        duplicate = provider.refresh_latest_if_due(now=after_publication)

        self.assertEqual(bootstrap["status"], "refreshed")
        self.assertEqual(published["status"], "refreshed")
        self.assertEqual(duplicate["status"], "not_due")
        self.assertEqual(self.calls, [2026, 2026])
        self.assertEqual(published["snapshot"]["effectiveDate"], "2026-01-12")


if __name__ == "__main__":
    unittest.main()
