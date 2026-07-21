import math
import unittest

from scripts.estimate_weekend_lambda import (
    _invert_straddle_total_variance,
    _summarize,
)


def _normal_cdf(value: float) -> float:
    return 0.5 * (1.0 + math.erf(value / math.sqrt(2.0)))


def _black76_price(
    right: str,
    forward: float,
    strike: float,
    time_years: float,
    rate: float,
    volatility: float,
) -> float:
    root_time = math.sqrt(time_years)
    d1 = (
        math.log(forward / strike) + 0.5 * volatility * volatility * time_years
    ) / (volatility * root_time)
    d2 = d1 - volatility * root_time
    discount = math.exp(-rate * time_years)
    if right == "call":
        return discount * (
            forward * _normal_cdf(d1) - strike * _normal_cdf(d2)
        )
    return discount * (
        strike * _normal_cdf(-d2) - forward * _normal_cdf(-d1)
    )


class WeekendLambdaStraddleInversionTests(unittest.TestCase):
    def test_recovers_off_forward_black76_total_variance(self):
        forward = 7530.0
        strike = 7525.0
        time_years = 17.0 / 365.0
        rate = 0.04
        volatility = 0.1375
        straddle = _black76_price(
            "call", forward, strike, time_years, rate, volatility
        ) + _black76_price(
            "put", forward, strike, time_years, rate, volatility
        )

        solved = _invert_straddle_total_variance(
            forward, strike, time_years, rate, straddle
        )

        self.assertIsNotNone(solved)
        self.assertAlmostEqual(
            solved,
            volatility * volatility * time_years,
            places=11,
        )

    def test_rejects_the_deterministic_floor(self):
        forward = 101.0
        strike = 100.0
        time_years = 7.0 / 365.0
        rate = 0.04
        floor = math.exp(-rate * time_years) * abs(forward - strike)

        self.assertIsNone(
            _invert_straddle_total_variance(
                forward, strike, time_years, rate, floor
            )
        )

    def test_summary_separates_raw_and_admissible_lambda(self):
        # The fixture must be ASYMMETRIC about the admissible band, otherwise
        # the two medians coincide and the assertions below cannot tell the
        # raw median from the admissible one. Here the two inadmissible values
        # both sit above 1 (a real case: price-derived lambdas are unclamped),
        # so dropping them moves the median 0.600 -> 0.200.
        summary = _summarize("test", [0.1, 0.2, 0.6, 1.4, 1.8])
        self.assertIn("raw_med= 0.600", summary)
        self.assertIn("valid_med= 0.200", summary)
        self.assertIn("valid[0,1]=60.0%", summary)


if __name__ == "__main__":
    unittest.main()
