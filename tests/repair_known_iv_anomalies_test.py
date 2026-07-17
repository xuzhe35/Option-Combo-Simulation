"""Unit tests for the guarded known-IV repair math and mutation."""

import importlib.util
import math
import sqlite3
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "repair_known_iv_anomalies.py"
SPEC = importlib.util.spec_from_file_location("iv_repair", SCRIPT)
iv_repair = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = iv_repair
SPEC.loader.exec_module(iv_repair)


class ImpliedVolatilityTest(unittest.TestCase):
    def test_pair_inversion_recovers_forward_and_volatility(self):
        forward, strike, tau, rate, volatility = 101.25, 100.0, 21 / 365, 0.03, 0.24
        call, put = iv_repair.black76_prices(forward, strike, tau, rate, volatility)
        actual_iv, actual_forward = iv_repair.implied_volatility_from_pair(
            call, put, strike, tau, rate
        )
        self.assertAlmostEqual(actual_forward, forward, places=10)
        self.assertAlmostEqual(actual_iv, volatility, places=10)


class ApplyRepairTest(unittest.TestCase):
    def test_guarded_update_records_old_and_new_values(self):
        database = sqlite3.connect(":memory:")
        database.execute(
            "CREATE TABLE options_data_clean (id INTEGER PRIMARY KEY, implied_volatility REAL)"
        )
        database.execute("INSERT INTO options_data_clean VALUES (7, 0.01488)")
        database.commit()
        repair = iv_repair.Repair(
            row_id=7,
            contract="SPY_TEST",
            symbol="SPY",
            quote_date="2026-01-02",
            expiration="2026-01-09",
            strike=100.0,
            option_type="call",
            old_iv=0.01488,
            new_iv=0.20,
            call_mid=1.0,
            put_mid=1.0,
            risk_free_rate=0.03,
        )
        self.assertEqual(iv_repair.apply_repairs(database, [repair]), 1)
        self.assertAlmostEqual(
            database.execute(
                "SELECT implied_volatility FROM options_data_clean WHERE id=7"
            ).fetchone()[0],
            0.20,
        )
        audit = database.execute(
            "SELECT old_iv, new_iv, method FROM iv_repair_audit WHERE option_row_id=7"
        ).fetchone()
        self.assertEqual(audit, (0.01488, 0.20, "black76_pair_bbo_mid_v1"))

    def test_rejects_non_exact_sentinel_before_opening_transaction(self):
        database = sqlite3.connect(":memory:")
        database.execute(
            "CREATE TABLE options_data_clean (id INTEGER PRIMARY KEY, implied_volatility REAL)"
        )
        database.execute("INSERT INTO options_data_clean VALUES (7, 0.02)")
        database.commit()
        repair = iv_repair.Repair(
            row_id=7, contract="SPY_TEST", symbol="SPY",
            quote_date="2026-01-02", expiration="2026-01-09", strike=100.0,
            option_type="call", old_iv=0.02, new_iv=0.20,
            call_mid=1.0, put_mid=1.0, risk_free_rate=0.03,
        )
        with self.assertRaisesRegex(RuntimeError, "exact .* sentinel"):
            iv_repair.apply_repairs(database, [repair])
        self.assertEqual(
            database.execute(
                "SELECT implied_volatility FROM options_data_clean WHERE id=7"
            ).fetchone()[0],
            0.02,
        )

    def test_cas_failure_rolls_back_every_row(self):
        database = sqlite3.connect(":memory:")
        database.execute(
            "CREATE TABLE options_data_clean (id INTEGER PRIMARY KEY, implied_volatility REAL)"
        )
        database.executemany(
            "INSERT INTO options_data_clean VALUES (?, ?)",
            [(7, 0.01488), (8, 0.01489)],
        )
        database.commit()

        def repair(row_id, option_type):
            return iv_repair.Repair(
                row_id=row_id, contract=f"SPY_{option_type}", symbol="SPY",
                quote_date="2026-01-02", expiration="2026-01-09", strike=100.0,
                option_type=option_type, old_iv=0.01488, new_iv=0.20,
                call_mid=1.0, put_mid=1.0, risk_free_rate=0.03,
            )

        with self.assertRaisesRegex(RuntimeError, "transaction rolled back"):
            iv_repair.apply_repairs(database, [repair(7, "call"), repair(8, "put")])
        self.assertEqual(
            database.execute(
                "SELECT id, implied_volatility FROM options_data_clean ORDER BY id"
            ).fetchall(),
            [(7, 0.01488), (8, 0.01489)],
        )


class CollectRepairGuardTest(unittest.TestCase):
    def _databases(self, rows):
        database = sqlite3.connect(":memory:")
        database.executescript(
            """
            CREATE TABLE symbols (symbol_id INTEGER PRIMARY KEY, symbol TEXT);
            CREATE TABLE dates (date_id INTEGER PRIMARY KEY, date TEXT);
            CREATE TABLE contracts (contract_id INTEGER PRIMARY KEY, contract_text TEXT);
            CREATE TABLE options_data_clean (
                id INTEGER PRIMARY KEY, symbol_ref INTEGER, date_ref INTEGER,
                expiration_ref INTEGER, contract_ref INTEGER, strike REAL,
                type TEXT, bid REAL, ask REAL, implied_volatility REAL
            );
            INSERT INTO symbols VALUES (1, 'SPY');
            INSERT INTO dates VALUES (1, '2010-03-12');
            INSERT INTO dates VALUES (2, '2010-03-31');
            """
        )
        for index, (option_type, bid, ask, iv) in enumerate(rows, start=1):
            database.execute("INSERT INTO contracts VALUES (?, ?)", (index, f"SPY_{index}"))
            database.execute(
                "INSERT INTO options_data_clean VALUES (?, 1, 1, 2, ?, 115, ?, ?, ?, ?)",
                (index, index, option_type, bid, ask, iv),
            )
        database.commit()
        rates = sqlite3.connect(":memory:")
        rates.executescript(
            """
            CREATE TABLE dates (date_id INTEGER PRIMARY KEY, date TEXT);
            CREATE TABLE risk_free_daily_rates (date_ref INTEGER, rate REAL);
            INSERT INTO dates VALUES (1, '2010-03-12');
            INSERT INTO risk_free_daily_rates VALUES (1, 0.0025);
            """
        )
        return database, rates

    def test_requires_exactly_one_call_and_one_put(self):
        database, rates = self._databases([
            ("call", 1.64, 1.66, 0.01488),
            ("put", 1.52, 1.56, 0.01488),
            ("call", 1.64, 1.66, 0.01488),
        ])
        with self.assertRaisesRegex(RuntimeError, "exactly two rows"):
            iv_repair.collect_repairs(database, rates)

    def test_rejects_wide_spreads_and_partial_sentinel_state(self):
        wide_db, wide_rates = self._databases([
            ("call", 1.0, 1.5, 0.01488),
            ("put", 1.52, 1.56, 0.01488),
        ])
        with self.assertRaisesRegex(RuntimeError, "spread is too wide"):
            iv_repair.collect_repairs(wide_db, wide_rates)

        partial_db, partial_rates = self._databases([
            ("call", 1.64, 1.66, 0.01488),
            ("put", 1.52, 1.56, 0.15),
        ])
        with self.assertRaisesRegex(RuntimeError, "partial sentinel"):
            iv_repair.collect_repairs(partial_db, partial_rates)

    def test_nearby_low_iv_is_not_the_exact_vendor_sentinel(self):
        database, rates = self._databases([
            ("call", 1.64, 1.66, 0.02),
            ("put", 1.52, 1.56, 0.02),
        ])
        repairs, _audit = iv_repair.collect_repairs(database, rates)
        self.assertEqual(repairs, [])


if __name__ == "__main__":
    unittest.main()
