import unittest

from trade_execution.models import ComboLegRequest


class ComboLegRequestQuoteParsingTests(unittest.TestCase):
    def test_observed_quote_aliases_preserve_zero(self):
        camel_case = ComboLegRequest.from_payload({
            'observedBid': 0,
            'observedAsk': '0',
            'observedMark': 0.0,
            # A valid primary zero must not fall through to an alias.
            'observed_bid': 9,
            'observed_ask': 9,
            'observed_mark': 9,
        })

        self.assertEqual(camel_case.observed_bid, 0.0)
        self.assertEqual(camel_case.observed_ask, 0.0)
        self.assertEqual(camel_case.observed_mark, 0.0)

        snake_case = ComboLegRequest.from_payload({
            'observedBid': '',
            'observedAsk': None,
            'observedMark': '',
            'observed_bid': 0,
            'observed_ask': '0',
            'observed_mark': 0.0,
        })

        self.assertEqual(snake_case.observed_bid, 0.0)
        self.assertEqual(snake_case.observed_ask, 0.0)
        self.assertEqual(snake_case.observed_mark, 0.0)

    def test_missing_observed_quote_aliases_remain_none(self):
        leg = ComboLegRequest.from_payload({})

        self.assertIsNone(leg.observed_bid)
        self.assertIsNone(leg.observed_ask)
        self.assertIsNone(leg.observed_mark)


if __name__ == '__main__':
    unittest.main()
