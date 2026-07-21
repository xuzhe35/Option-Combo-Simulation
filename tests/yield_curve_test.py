"""Tests for the standalone unified SOFR/Treasury yield curve."""

import json
import math
import sys
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from yield_curve.builder import (  # noqa: E402
    build_discount_curve_snapshot,
    resolve_snapshot_discount,
    sofr_act360_to_continuous_act365f,
)
from yield_curve.backend_adapter import YieldCurveBackendAdapter  # noqa: E402
from yield_curve.repository import YieldCurveRepository  # noqa: E402
from yield_curve.sources.new_york_fed import parse_sofr_payload  # noqa: E402
from yield_curve.updater import (  # noqa: E402
    YieldCurveUpdater,
    most_recent_market_business_date,
)


SOFR = {
    "source": "nyfed:sofr",
    "effectiveDate": "2026-07-16",
    "rate": 0.0362,
    "dayCount": "ACT/360",
}

TREASURY = {
    "source": "treasury:daily_treasury_yield_curve",
    "effectiveDate": "2026-07-17",
    "points": [
        {"tenorCode": "1m", "tenorDays": 30, "parYield": 0.0400, "continuousRate": 2 * math.log1p(0.0400 / 2)},
        {"tenorCode": "1.5m", "tenorDays": 46, "parYield": 0.0405, "continuousRate": 2 * math.log1p(0.0405 / 2)},
        {"tenorCode": "2m", "tenorDays": 61, "parYield": 0.0410, "continuousRate": 2 * math.log1p(0.0410 / 2)},
        {"tenorCode": "3m", "tenorDays": 91, "parYield": 0.0420, "continuousRate": 2 * math.log1p(0.0420 / 2)},
    ],
}


def build_sample(curve_date="2026-07-19"):
    return build_discount_curve_snapshot(
        curve_date,
        SOFR,
        TREASURY,
        generated_at=datetime.fromisoformat("{}T12:00:00+00:00".format(curve_date)),
    )


class SourceSemanticsTest(unittest.TestCase):
    def test_sofr_act360_conversion_preserves_one_day_discount(self):
        rate = 0.0525
        continuous = sofr_act360_to_continuous_act365f(rate)
        self.assertAlmostEqual(
            math.exp(-continuous / 365),
            1 / (1 + rate / 360),
            places=15,
        )

    def test_sofr_averages_are_diagnostics_not_forward_nodes(self):
        parsed = parse_sofr_payload({
            "refRates": [
                {
                    "type": "SOFR",
                    "effectiveDate": "2026-07-16",
                    "percentRate": "3.62",
                    "volumeInBillions": "3038",
                },
                {
                    "type": "SOFRAI",
                    "effectiveDate": "2026-07-17",
                    "average30day": "3.62105",
                    "average90day": "3.62922",
                    "average180day": "3.66565",
                    "index": "1.2345",
                },
            ]
        }, "2026-07-19")
        self.assertAlmostEqual(parsed["rate"], 0.0362)
        diagnostics = parsed["backwardLookingDiagnostics"]
        self.assertAlmostEqual(diagnostics["average30Day"], 0.0362105)
        self.assertIn("backward_looking", diagnostics["semantics"])
        self.assertNotIn("points", parsed)


class HybridBuilderTest(unittest.TestCase):
    def test_builds_sofr_short_end_smooth_blend_and_treasury_slope(self):
        snapshot = build_sample()
        by_day = {point["tenorDays"]: point for point in snapshot["points"]}
        self.assertEqual(snapshot["schemaVersion"], 2)
        self.assertEqual(snapshot["kind"], "hybrid_discount_curve")
        self.assertEqual(snapshot["curveAsOf"], "2026-07-19")
        self.assertEqual(snapshot["effectiveDate"], "2026-07-16")
        self.assertEqual(snapshot["policy"]["sofrAveragesUsage"], "diagnostics_only_backward_looking_not_curve_nodes")
        self.assertEqual(sorted(day for day in by_day if 30 <= day <= 46), list(range(30, 47)))

        sofr_cc = sofr_act360_to_continuous_act365f(SOFR["rate"])
        self.assertAlmostEqual(by_day[30]["zeroRate"], sofr_cc, places=14)
        self.assertEqual(by_day[30]["sourceEffectiveDate"], "2026-07-16")
        self.assertEqual(by_day[31]["inputSemantics"], "smoothstep_instantaneous_forward_blend")
        self.assertEqual(by_day[61]["sourceEffectiveDate"], "2026-07-17")

        # D is continuous at the boundary and the first daily forward step is
        # almost SOFR; no 30/31-day hard-switch jump is introduced.
        d30 = by_day[30]["discountFactor"]
        d31 = by_day[31]["discountFactor"]
        first_forward = -math.log(d31 / d30) * 365
        self.assertAlmostEqual(first_forward, sofr_cc, delta=2e-5)
        self.assertLess(abs(by_day[31]["zeroRate"] - by_day[30]["zeroRate"]), 2e-5)

        for days in (0, 7, 30, 31, 46, 61, 91):
            quote = resolve_snapshot_discount(snapshot, days)
            self.assertGreater(quote["discountFactor"], 0)
            self.assertLessEqual(quote["discountFactor"], 1.001)

    def test_treasury_only_fallback_is_explicitly_degraded(self):
        snapshot = build_discount_curve_snapshot(
            "2026-07-19",
            None,
            TREASURY,
            generated_at=datetime(2026, 7, 19, tzinfo=timezone.utc),
        )
        self.assertEqual(snapshot["kind"], "treasury_discount_curve")
        self.assertIn("sofr_unavailable", snapshot["quality"]["flags"])
        self.assertTrue(all(point["proxy"] for point in snapshot["points"]))


class MarketBusinessDateTest(unittest.TestCase):
    def test_weekend_clamps_to_friday_and_weekdays_pass_through(self):
        # 2026-07-19 12:00 UTC is Sunday 08:00 in New York.
        sunday = datetime(2026, 7, 19, 12, tzinfo=timezone.utc)
        self.assertEqual(most_recent_market_business_date(sunday), date(2026, 7, 17))
        # 2026-07-19 02:00 UTC is still Saturday 22:00 in New York.
        saturday_ny = datetime(2026, 7, 19, 2, tzinfo=timezone.utc)
        self.assertEqual(most_recent_market_business_date(saturday_ny), date(2026, 7, 17))
        monday = datetime(2026, 7, 20, 12, tzinfo=timezone.utc)
        self.assertEqual(most_recent_market_business_date(monday), date(2026, 7, 20))


class RepositoryAndUpdaterTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.repository = YieldCurveRepository(self.tmpdir.name)

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_atomic_latest_and_strict_on_or_before_with_corrupt_latest(self):
        first = build_sample("2026-07-18")
        second = build_sample("2026-07-19")
        paths = self.repository.write_snapshot(first)
        self.repository.write_snapshot(second)
        self.assertTrue(Path(paths["historyPath"]).exists())
        self.assertEqual(self.repository.load_on_or_before("2026-07-18")["snapshotId"], first["snapshotId"])
        self.assertIsNone(self.repository.load_on_or_before("2026-07-17"))

        Path(self.repository.latest_path).write_text("{broken", encoding="utf-8")
        self.assertEqual(self.repository.load_latest()["snapshotId"], second["snapshotId"])

    def test_failed_source_does_not_overwrite_last_complete_snapshot(self):
        now = lambda: datetime(2026, 7, 19, 12, tzinfo=timezone.utc)
        updater = YieldCurveUpdater(
            repository=self.repository,
            sofr_loader=lambda _target: SOFR,
            treasury_loader=lambda _target: TREASURY,
            now=now,
        )
        first = updater.update()
        self.assertEqual(first["status"], "updated")
        first_id = first["snapshot"]["snapshotId"]

        skipped = updater.update(if_needed=True)
        self.assertEqual(skipped["status"], "not_due")
        failing = YieldCurveUpdater(
            repository=self.repository,
            sofr_loader=lambda _target: (_ for _ in ()).throw(RuntimeError("SOFR offline")),
            treasury_loader=lambda _target: TREASURY,
            now=lambda: datetime(2026, 7, 20, 12, tzinfo=timezone.utc),
        ).update()
        self.assertEqual(failing["status"], "cache_fallback")
        self.assertEqual(self.repository.load_latest()["snapshotId"], first_id)

    def test_weekend_update_stamps_the_friday_business_date(self):
        updater = YieldCurveUpdater(
            repository=self.repository,
            sofr_loader=lambda _target: SOFR,
            treasury_loader=lambda _target: TREASURY,
            # NY Sunday: without the business-day clamp this stamped
            # curveAsOf=2026-07-19 and postdated every Friday quote date.
            now=lambda: datetime(2026, 7, 19, 12, tzinfo=timezone.utc),
        )
        result = updater.update()
        self.assertEqual(result["status"], "updated")
        self.assertEqual(result["snapshot"]["curveAsOf"], "2026-07-17")
        self.assertEqual(result["snapshot"]["effectiveDate"], "2026-07-16")

        rerun = updater.update(if_needed=True)
        self.assertEqual(rerun["status"], "not_due")

    def test_snapshot_and_raw_components_are_durable_json(self):
        updater = YieldCurveUpdater(
            repository=self.repository,
            sofr_loader=lambda _target: SOFR,
            treasury_loader=lambda _target: TREASURY,
            now=lambda: datetime(2026, 7, 19, 12, tzinfo=timezone.utc),
        )
        result = updater.update()
        for path in [result["paths"]["latestPath"], *result["rawPaths"].values()]:
            with Path(path).open("r", encoding="utf-8") as handle:
                self.assertIsInstance(json.load(handle), dict)


class BackendAdapterTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()

    async def asyncTearDown(self):
        self.tmpdir.cleanup()

    async def test_historical_request_is_read_only_and_strict_as_of(self):
        adapter = YieldCurveBackendAdapter(
            self.tmpdir.name,
            auto_update_if_missing=True,
            auto_update_if_stale=True,
        )
        calls = []

        async def forbidden_update(target):
            calls.append(target)
            raise AssertionError("historical query must not start updater")

        adapter._run_update_once = forbidden_update
        payload = await adapter.build_payload({"requestedDate": "2022-01-03"})
        self.assertEqual(payload["status"], "unavailable")
        self.assertFalse(payload["refreshAttempted"])
        self.assertEqual(calls, [])

    async def test_weekend_request_keeps_friday_snapshot_without_updating(self):
        adapter = YieldCurveBackendAdapter(self.tmpdir.name)
        adapter.repository.write_snapshot(build_sample("2026-07-17"))

        async def forbidden_update(target):
            raise AssertionError("weekend request must not re-run the updater")

        adapter._run_update_once = forbidden_update
        with mock.patch(
            "yield_curve.backend_adapter.most_recent_market_business_date",
            return_value=date(2026, 7, 17),
        ):
            payload = await adapter.build_payload({})
        self.assertEqual(payload["status"], "cached")
        self.assertFalse(payload["fallbackUsed"])
        self.assertEqual(payload["error"], "")

    async def test_missing_live_file_self_heals_once_through_adapter_boundary(self):
        adapter = YieldCurveBackendAdapter(self.tmpdir.name)
        calls = []

        async def fake_update(target):
            calls.append(target)
            snapshot = build_sample(target)
            adapter.repository.write_snapshot(snapshot)
            return {"attempted": True, "error": ""}

        adapter._run_update_once = fake_update
        first = await adapter.build_payload({})
        second = await adapter.build_payload({})
        self.assertEqual(first["status"], "updated")
        self.assertEqual(second["status"], "cached")
        self.assertEqual(len(calls), 1)
        self.assertEqual(
            first["curve"]["snapshotId"],
            second["curve"]["snapshotId"],
        )


if __name__ == "__main__":
    unittest.main()
