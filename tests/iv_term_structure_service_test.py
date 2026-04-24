import pathlib
import sys
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


import iv_term_structure_service


class IvTermStructureServiceTests(unittest.TestCase):
    def test_filter_expiry_rows_keeps_sorted_candidates_within_max_dte(self):
        rows = iv_term_structure_service.filter_expiry_rows(
            ['20260424', '20261021', '20260426', 'bad', '20270424'],
            '2026-04-23',
            200,
        )

        self.assertEqual(
            rows,
            [
                {'expiry': '20260424', 'dte': 1},
                {'expiry': '20260426', 'dte': 3},
                {'expiry': '20261021', 'dte': 181},
            ],
        )

    def test_pick_strike_window_returns_nearest_strike_with_neighbors(self):
        strikes = [480, 485, 490, 495, 500, 505]

        window = iv_term_structure_service.pick_strike_window(
            strikes,
            496.2,
            radius=1,
        )

        self.assertEqual(window['atm_strike'], 495.0)
        self.assertEqual(window['window_strikes'], [490.0, 495.0, 500.0])

    def test_pick_strike_window_prefers_lower_strike_on_exact_tie(self):
        strikes = [495, 500]

        window = iv_term_structure_service.pick_strike_window(
            strikes,
            497.5,
            radius=1,
        )

        self.assertEqual(window['atm_strike'], 495.0)
        self.assertEqual(window['window_strikes'], [495.0, 500.0])

    def test_pick_strike_window_handles_missing_inputs_without_throwing(self):
        self.assertEqual(
            iv_term_structure_service.pick_strike_window([], 500, radius=1),
            {'atm_strike': None, 'window_strikes': []},
        )
        self.assertEqual(
            iv_term_structure_service.pick_strike_window([500, 505], None, radius=1),
            {'atm_strike': None, 'window_strikes': []},
        )

    def test_choose_trading_class_keeps_explicit_request(self):
        self.assertEqual(
            iv_term_structure_service.choose_trading_class(['SPY', 'SPYW'], requested_trading_class='SPYW'),
            'SPYW',
        )

    def test_choose_trading_class_returns_blank_when_chain_is_mixed(self):
        self.assertEqual(
            iv_term_structure_service.choose_trading_class(['SPY', '2SPY', 'SPYW']),
            '',
        )

    def test_choose_trading_class_returns_only_unique_non_blank_class(self):
        self.assertEqual(
            iv_term_structure_service.choose_trading_class(['', 'GLD', 'GLD']),
            'GLD',
        )

    def test_build_expiry_strike_selections_uses_expiry_specific_ladders(self):
        selections = iv_term_structure_service.build_expiry_strike_selections(
            [
                {'expiry': '20260424', 'strike': 711, 'tradingClass': 'SPY'},
                {'expiry': '20260424', 'strike': 712, 'tradingClass': 'SPY'},
                {'expiry': '20260424', 'strike': 713, 'tradingClass': 'SPY'},
                {'expiry': '20260930', 'strike': 710, 'tradingClass': 'SPY'},
                {'expiry': '20260930', 'strike': 715, 'tradingClass': 'SPY'},
            ],
            711.63,
            radius=1,
        )

        self.assertEqual(
            selections['20260424'],
            {
                'atm_strike': 712.0,
                'window_strikes': [711.0, 712.0, 713.0],
                'tradingClass': 'SPY',
            },
        )
        self.assertEqual(
            selections['20260930'],
            {
                'atm_strike': 710.0,
                'window_strikes': [710.0, 715.0],
                'tradingClass': 'SPY',
            },
        )


if __name__ == '__main__':
    unittest.main()
