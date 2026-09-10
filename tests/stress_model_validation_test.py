"""Deterministic tests for the stress-model research helpers.

These tests deliberately avoid the local options-chain service.  They check
the numerical building blocks used by ``scripts/stress_model_validation.py``
and ``scripts/skew_regime_study.py`` so research reruns cannot silently change
their filtering, interpolation, regression, or pricing semantics.

Run: python3 tests/stress_model_validation_test.py
"""

import math
import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts import skew_regime_study as skew_study
from scripts import stress_model_validation as validation


class StressModelResearchHelpersTest(unittest.TestCase):
    def test_smile_keeps_only_real_bid_and_valid_iv_then_sorts_by_moneyness(self):
        quotes = [
            {"strike": 105, "impliedVolatility": 0.19, "bid": 1.0},
            {"strike": 90, "impliedVolatility": 0.24, "bid": 0.5},
            {"strike": 95, "impliedVolatility": 0.22, "bid": 0},
            {"strike": 100, "impliedVolatility": 3.2, "bid": 1.0},
            {"strike": 40, "impliedVolatility": 0.30, "bid": 1.0},
        ]

        points = validation.smile(quotes, 100)

        self.assertEqual([point[2] for point in points], [90, 105])
        self.assertAlmostEqual(points[0][0], math.log(0.9))
        self.assertAlmostEqual(points[1][0], math.log(1.05))

    def test_interpolation_is_linear_and_clamped_at_observed_edges(self):
        points = [(-0.2, 0.30, 80, {}), (0.0, 0.20, 100, {}), (0.2, 0.24, 120, {})]

        self.assertEqual(validation.interp([], 0), None)
        self.assertAlmostEqual(validation.interp(points, -0.3), 0.30)
        self.assertAlmostEqual(validation.interp(points, -0.1), 0.25)
        self.assertAlmostEqual(validation.interp(points, 0.1), 0.22)
        self.assertAlmostEqual(validation.interp(points, 0.3), 0.24)

    def test_origin_regression_recovers_known_spot_vol_beta(self):
        drops = [2.0, 4.0, 7.5, 12.0]
        iv_lifts = [1.86, 3.72, 6.975, 11.16]

        self.assertAlmostEqual(validation.regress_origin(drops, iv_lifts), 0.93)
        self.assertTrue(math.isnan(validation.regress_origin([], [])))

    def test_research_pricers_respect_intrinsic_and_american_put_bound(self):
        self.assertEqual(validation.bsm_put(60, 100, 0, 0.05, 0, 0.2), 40)
        european = validation.bsm_put(100, 100, 1, 0.05, 0, 0.2)
        american = validation.crr_put(100, 100, 1, 0.05, 0, 0.2, steps=121)

        self.assertAlmostEqual(european, 5.573526, places=5)
        self.assertGreaterEqual(american, european)

    def test_skew_study_rmse_and_interpolation_are_deterministic(self):
        self.assertAlmostEqual(skew_study.rmse([3, 4]), math.sqrt(12.5))
        points = [(-0.2, 0.30, 80), (0.0, 0.20, 100)]
        self.assertAlmostEqual(skew_study.interp(points, -0.1), 0.25)
        self.assertTrue(math.isnan(skew_study.rmse([])))

    def test_drop_buckets_have_closed_lower_and_open_upper_edges(self):
        self.assertIsNone(validation.bucket_for_drop(1.99))
        self.assertEqual(validation.bucket_for_drop(2.0), "2-5")
        self.assertEqual(validation.bucket_for_drop(4.999), "2-5")
        self.assertEqual(validation.bucket_for_drop(5.0), "5-10")
        self.assertEqual(validation.bucket_for_drop(10.0), "10-20")
        self.assertEqual(validation.bucket_for_drop(19.99), "10-20")
        self.assertEqual(validation.bucket_for_drop(20.0), "20+")
        self.assertEqual(validation.bucket_for_drop(80.0), "20+")

    def test_beta_table_regresses_per_bucket_rounds_and_inherits_thin_buckets(self):
        pooled = {
            "2-5": ([2.0, 3.0, 4.0, 4.5, 3.5], [1.8, 2.7, 3.6, 4.05, 3.15]),      # beta 0.90
            "5-10": ([6.0, 7.0, 8.0, 9.0, 5.5], [5.7, 6.65, 7.6, 8.55, 5.225]),   # beta 0.95
            "10-20": ([12.0, 15.0, 18.0, 11.0, 19.0], [12.0, 15.0, 18.0, 11.0, 19.0]),  # beta 1.00
            "20+": ([25.0, 30.0], [41.25, 49.5]),                                # n=2: thin
        }
        rows = validation.beta_table_from_pairs(pooled)
        self.assertEqual([row["bucket"] for row in rows], ["2-5", "5-10", "10-20", "20+"])
        self.assertAlmostEqual(rows[0]["beta"], 0.90)
        self.assertEqual(rows[0]["value"], 0.90)
        self.assertEqual(rows[1]["value"], 0.95)
        self.assertEqual(rows[2]["value"], 1.00)
        self.assertTrue(rows[3]["inherited"])
        self.assertEqual(rows[3]["value"], 1.00)
        self.assertEqual(rows[3]["n"], 2)
        # rounding is to the nearest 0.05
        rows2 = validation.beta_table_from_pairs({"2-5": ([2.0] * 5, [2.0 * 1.12] * 5)})
        self.assertEqual(rows2[0]["value"], 1.10)

    def test_otm_ratio_needs_a_real_atm_lift(self):
        self.assertIsNone(validation.otm_lift_ratio(1.9, 1.0))
        self.assertIsNone(validation.otm_lift_ratio(5.0, None))
        self.assertIsNone(validation.otm_lift_ratio(None, 1.0))
        self.assertAlmostEqual(validation.otm_lift_ratio(20.0, 10.0), 0.5)
        self.assertAlmostEqual(validation.otm_lift_ratio(2.0, 3.0), 1.5)

    def test_tenor_exponent_fit_uses_each_episode_actual_front_dte(self):
        # Two episodes with different front contracts; ratios follow p = 0.6
        # exactly, so both the least-squares fit and the per-row median
        # must recover 0.6 - only if the actual front DTE is used.
        p = 0.6
        summary = []
        for front_dte, front_shift, dtes in ((39, 0.10, (46, 109, 263, 364)), (32, 0.14, (60, 123, 227, 318))):
            summary.append({"dte0": front_dte, "shift_ss": front_shift,
                            "front_shift": front_shift, "front_dte": front_dte})
            for dte in dtes:
                summary.append({"dte0": dte, "shift_ss": front_shift * (front_dte / dte) ** p,
                                "front_shift": front_shift, "front_dte": front_dte})
        rows = skew_study.tenor_ratio_rows(summary)
        self.assertEqual(len(rows), 10)
        buckets = skew_study.tenor_bucket_summaries(rows)
        bucket_60 = next(row for row in buckets if row["dte_bucket"] == 60)
        self.assertAlmostEqual(bucket_60["p_050"],
                               ((39 / 46) ** 0.5 + (32 / 60) ** 0.5) / 2)
        self.assertAlmostEqual(bucket_60["p_065"],
                               ((39 / 46) ** 0.65 + (32 / 60) ** 0.65) / 2)
        p_hat, n = skew_study.fit_tenor_exponent(rows)
        self.assertEqual(n, 8)
        self.assertAlmostEqual(p_hat, p, places=9)
        p_med, n_med = skew_study.median_row_exponent(rows)
        self.assertEqual(n_med, 8)
        self.assertAlmostEqual(p_med, p, places=9)
        # A bucket-centre fit would NOT recover it: 39->46 is not 30->60.
        wrong_x = [math.log(30 / 60)] * 2
        wrong_y = [math.log((39 / 46) ** p), math.log((32 / 60) ** p)]
        wrong_p = sum(x * y for x, y in zip(wrong_x, wrong_y)) / sum(x * x for x in wrong_x)
        self.assertNotAlmostEqual(wrong_p, p, places=2)
        # Negative or zero ratios and contracts shorter than the front are skipped.
        rows.append({"dte0": 500, "front_dte": 39, "ratio": -0.2})
        rows.append({"dte0": 20, "front_dte": 39, "ratio": 0.9})
        self.assertEqual(skew_study.fit_tenor_exponent(rows)[1], 8)
        self.assertEqual(skew_study.tenor_ratio_rows([{"dte0": 30, "shift_ss": 0.1, "front_shift": 0.0, "front_dte": 30}]), [])
        self.assertTrue(math.isnan(skew_study.fit_tenor_exponent([])[0]))


if __name__ == "__main__":
    unittest.main()
