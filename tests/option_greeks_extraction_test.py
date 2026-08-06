import math
import pathlib
import sys
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


from ib_server_market_data import (
    OPTION_GREEK_FIELDS,
    extract_option_delta,
    extract_option_greek,
    extract_option_greeks,
)


class _FakeGreeks:
    def __init__(self, **values):
        for name, value in values.items():
            setattr(self, name, value)


class _FakeTicker:
    def __init__(self, model=None, bid=None, ask=None, last=None):
        self.modelGreeks = model
        self.bidGreeks = bid
        self.askGreeks = ask
        self.lastGreeks = last


class OptionGreeksExtractionTests(unittest.TestCase):
    def test_extracts_every_model_greek_from_one_message(self):
        ticker = _FakeTicker(model=_FakeGreeks(
            delta=0.4231118,
            gamma=0.0123,
            vega=0.31,
            theta=-0.0875,
            impliedVol=0.19,
        ))

        greeks = extract_option_greeks(ticker)

        self.assertEqual(
            greeks,
            {'delta': 0.423112, 'gamma': 0.0123, 'vega': 0.31, 'theta': -0.0875},
        )

    def test_omits_a_greek_ib_has_not_computed(self):
        # A greek IB has not published must be absent, not zero: the browser
        # tells "waiting on TWS" apart from a genuinely flat greek by presence.
        ticker = _FakeTicker(model=_FakeGreeks(delta=0.25, impliedVol=0.2))

        greeks = extract_option_greeks(ticker)

        self.assertEqual(greeks, {'delta': 0.25})
        self.assertNotIn('theta', greeks)

    def test_skips_nan_greeks(self):
        ticker = _FakeTicker(model=_FakeGreeks(delta=0.25, theta=float('nan')))

        greeks = extract_option_greeks(ticker)

        self.assertEqual(greeks, {'delta': 0.25})

    def test_falls_back_through_bid_ask_and_last_greeks(self):
        ticker = _FakeTicker(
            model=None,
            bid=_FakeGreeks(theta=-0.05),
            ask=_FakeGreeks(theta=-0.09),
        )

        self.assertEqual(extract_option_greek(ticker, 'theta'), -0.05)

    def test_returns_none_when_no_greek_source_exists(self):
        self.assertIsNone(extract_option_greek(_FakeTicker(), 'theta'))
        self.assertEqual(extract_option_greeks(_FakeTicker()), {})

    def test_delta_helper_still_matches_the_generic_extractor(self):
        ticker = _FakeTicker(model=_FakeGreeks(delta=-0.3333335, theta=-0.02))

        self.assertEqual(extract_option_delta(ticker), -0.333334)
        self.assertEqual(
            extract_option_delta(ticker),
            extract_option_greek(ticker, 'delta'),
        )

    def test_theta_rides_the_same_field_list_as_delta(self):
        # Theta must stay in the published set; dropping it would silently turn
        # Portfolio Greeks into a delta-only panel again.
        self.assertIn('delta', OPTION_GREEK_FIELDS)
        self.assertIn('theta', OPTION_GREEK_FIELDS)

    def test_zero_theta_is_published_rather_than_treated_as_missing(self):
        ticker = _FakeTicker(model=_FakeGreeks(delta=1.0, theta=0.0))

        greeks = extract_option_greeks(ticker)

        self.assertIn('theta', greeks)
        self.assertEqual(greeks['theta'], 0.0)
        self.assertFalse(math.isnan(greeks['theta']))


if __name__ == '__main__':
    unittest.main()
