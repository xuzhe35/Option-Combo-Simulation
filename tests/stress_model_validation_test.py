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


if __name__ == "__main__":
    unittest.main()
