import argparse
import contextlib
import importlib.util
import io
import pathlib
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPO_ROOT / "scripts" / "smoke_delta_hedge_ws.py"


def _load_smoke_module():
    spec = importlib.util.spec_from_file_location("smoke_delta_hedge_ws", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DeltaHedgeWsSmokeScriptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.smoke = _load_smoke_module()

    def test_build_payload_maps_safe_validate_action(self):
        args = argparse.Namespace(
            action="validate",
            hedge_id="delta_spy",
            hedge_name="SPY Delta Hedge",
            sec_type="stk",
            symbol="spy",
            exchange="SMART",
            currency="USD",
            contract_month="",
            multiplier="",
            side="buy",
            quantity=12,
            order_type="lmt",
            limit_price=481.25,
            time_in_force="day",
            account="",
            request_source="delta_hedge_smoke",
        )

        payload = self.smoke.build_payload(args)

        self.assertEqual(payload["action"], "validate_hedge_order")
        self.assertEqual(payload["hedgeId"], "delta_spy")
        self.assertEqual(payload["secType"], "STK")
        self.assertEqual(payload["symbol"], "SPY")
        self.assertEqual(payload["orderAction"], "BUY")
        self.assertEqual(payload["quantity"], 12)
        self.assertEqual(payload["orderType"], "LMT")
        self.assertEqual(payload["limitPrice"], 481.25)
        self.assertNotEqual(payload["action"], "submit_hedge_order")

    def test_build_payload_maps_preview_without_allowing_submit(self):
        parser = self.smoke.build_arg_parser()

        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                parser.parse_args(["--action", "submit"])

        args = parser.parse_args([
            "--action", "preview",
            "--sec-type", "STK",
            "--symbol", "SPY",
            "--side", "SELL",
            "--quantity", "1",
            "--order-type", "LMT",
            "--limit-price", "480.5",
        ])
        payload = self.smoke.build_payload(args)

        self.assertEqual(payload["action"], "preview_hedge_order")
        self.assertNotEqual(payload["action"], "submit_hedge_order")

    def test_lmt_payload_requires_positive_limit_price(self):
        parser = self.smoke.build_arg_parser()
        args = parser.parse_args([
            "--action", "validate",
            "--sec-type", "STK",
            "--symbol", "SPY",
            "--side", "BUY",
            "--quantity", "1",
            "--order-type", "LMT",
        ])

        with self.assertRaisesRegex(ValueError, "limit"):
            self.smoke.validate_payload_args(args)

    def test_future_payload_requires_contract_month(self):
        parser = self.smoke.build_arg_parser()
        args = parser.parse_args([
            "--action", "validate",
            "--sec-type", "FUT",
            "--symbol", "ES",
            "--exchange", "CME",
            "--side", "SELL",
            "--quantity", "1",
            "--order-type", "LMT",
            "--limit-price", "5125.25",
        ])

        with self.assertRaisesRegex(ValueError, "contract month"):
            self.smoke.validate_payload_args(args)

    def test_identifies_matching_terminal_response(self):
        result = {
            "action": "hedge_order_preview_result",
            "hedgeId": "delta_spy",
            "preview": {"symbol": "SPY"},
        }
        error = {
            "action": "hedge_order_error",
            "hedgeId": "delta_spy",
            "message": "No live IB connection.",
        }
        startup_message = {
            "action": "managed_accounts_update",
            "accounts": [],
        }

        self.assertTrue(self.smoke.is_target_response(result, "delta_spy"))
        self.assertTrue(self.smoke.is_target_response(error, "delta_spy"))
        self.assertFalse(self.smoke.is_target_response(startup_message, "delta_spy"))
        self.assertFalse(self.smoke.is_target_response(result, "other_hedge"))


if __name__ == "__main__":
    unittest.main()
