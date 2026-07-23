"""HistoricalReplayStore contract tests against a mock chain service.

Verifies that the HTTP-backed store returns the same payload shapes the old
bundled-SQLite store produced, so historical_replay_service.py and the
frontend keep working unchanged.

Run:  python3 tests/historical_replay_store_test.py
"""

import json
import math
import sqlite3
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from historical_data import ChainServiceError, HistoricalReplayStore


BARS = {
    "2022-01-03": {"date": "2022-01-03", "open": 476.0, "high": 478.0,
                   "low": 475.0, "close": 477.0, "volume": 100000},
    "2022-01-04": {"date": "2022-01-04", "open": 477.5, "high": 480.0,
                   "low": 477.0, "close": 479.5, "volume": 120000},
}

QUOTE_470_PUT = {
    "contract": "SPY220218P00470000", "contractId": 11,
    "expiration": "2022-02-18", "strike": 470.0, "type": "put",
    "bid": 8.0, "bidSize": 9, "ask": 8.1, "askSize": 4, "mark": 8.05,
    "last": 8.0, "volume": 50, "openInterest": 2000,
    "impliedVolatility": 0.20, "delta": -0.45, "gamma": 0.01,
    "theta": -0.04, "vega": 0.5, "rho": -0.2,
}


class MockChainServiceHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        params = {k: v[-1] for k, v in parse_qs(parsed.query).items()}
        route = parsed.path

        if route == "/health":
            return self._json(200, {"status": "ok", "symbols": ["SPY"]})

        if route == "/v1/symbols":
            return self._json(200, {"symbols": [{
                "symbol": "SPY",
                "chainFirstDate": "2008-01-02", "chainLastDate": "2026-06-26",
                "underlyingFirstDate": "1999-11-01",
                "underlyingLastDate": "2026-06-29",
                "underlyingBarCount": 6704,
            }]})

        if route == "/v1/underlying":
            requested = params.get("date", "")
            # on_or_before semantics over the two known bars
            candidates = [d for d in sorted(BARS) if d <= requested]
            if not candidates:
                return self._json(404, {"error": "no bar", "status": 404})
            effective = candidates[-1]
            return self._json(200, {
                "symbol": "SPY", "requestedDate": requested,
                "effectiveDate": effective, "bar": BARS[effective],
            })

        if route == "/v1/underlying-bars":
            bars = [BARS[d] for d in sorted(BARS)]
            start = params.get("start")
            end = params.get("end")
            if start:
                bars = [b for b in bars if b["date"] >= start]
            if end:
                bars = [b for b in bars if b["date"] <= end]
            return self._json(200, {"symbol": "SPY", "barSize": "1 day",
                                    "count": len(bars), "bars": bars})

        if route == "/v1/trading-dates":
            return self._json(200, {
                "symbol": "SPY", "dates": sorted(BARS), "count": len(BARS),
            })

        if route == "/v1/quote":
            if (params.get("date") == "2022-01-03"
                    and params.get("expiration") == "2022-02-18"
                    and params.get("type") == "put"
                    and abs(float(params.get("strike", 0)) - 470.0) < 0.001):
                return self._json(200, {
                    "symbol": "SPY", "requestedDate": params["date"],
                    "effectiveDate": params["date"], "quote": QUOTE_470_PUT,
                })
            return self._json(404, {"error": "no quote", "status": 404})

        return self._json(404, {"error": "unknown", "status": 404})

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def build_rates_db(path):
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE dates (date_id INTEGER PRIMARY KEY, date TEXT UNIQUE NOT NULL);
        CREATE TABLE risk_free_daily_rates (
            id INTEGER PRIMARY KEY, date_ref INTEGER NOT NULL,
            rate REAL, source TEXT);
        CREATE TABLE yield_curve_daily_rates (
            id INTEGER PRIMARY KEY, date_ref INTEGER NOT NULL,
            tenor_code TEXT, tenor_days INTEGER, rate REAL, source TEXT);
        INSERT INTO dates VALUES (1, '2022-01-03'), (2, '2022-01-04');
        INSERT INTO risk_free_daily_rates VALUES (1, 1, 0.0006, 'yfinance:^IRX');
        INSERT INTO yield_curve_daily_rates VALUES
            (1, 1, '1M', 30, 0.0005, 'treasury'),
            (2, 1, '10Y', 3650, 0.0163, 'treasury');
        """
    )
    con.commit()
    con.close()


class HistoricalReplayStoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), MockChainServiceHandler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

        cls.tmpdir = tempfile.TemporaryDirectory()
        cls.rates_db = str(Path(cls.tmpdir.name) / "rates.db")
        build_rates_db(cls.rates_db)

        cls.store = HistoricalReplayStore(
            f"http://127.0.0.1:{cls.port}", cls.rates_db,
            yield_curve_data_dir=Path(cls.tmpdir.name) / "yield_curve",
        )

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmpdir.cleanup()

    def test_check_service(self):
        health = self.store.check_service()
        self.assertEqual(health["status"], "ok")

    def test_underlying_date_bounds_use_chain_coverage(self):
        bounds = self.store.get_underlying_date_bounds("spy")
        self.assertEqual(bounds, {"startDate": "2008-01-02", "endDate": "2026-06-26"})
        self.assertIsNone(self.store.get_underlying_date_bounds("NOPE"))

    def test_underlying_snapshot_shape_matches_legacy_contract(self):
        snapshot = self.store.get_underlying_snapshot("SPY", "2022-01-05")
        self.assertEqual(snapshot["requestedDate"], "2022-01-05")
        self.assertEqual(snapshot["effectiveDate"], "2022-01-04")
        quote = snapshot["quote"]
        # legacy contract: bid/ask/mark all equal the daily close
        self.assertEqual(quote["bid"], 479.5)
        self.assertEqual(quote["ask"], 479.5)
        self.assertEqual(quote["mark"], 479.5)
        self.assertEqual(quote["open"], 477.5)
        self.assertEqual(quote["volume"], 120000)
        self.assertIn("adjClose", quote)
        self.assertIn("source", quote)

    def test_trading_dates_are_observed_service_sessions(self):
        self.assertEqual(
            self.store.get_trading_dates("SPY"),
            ["2022-01-03", "2022-01-04"],
        )

    def test_underlying_snapshot_without_date_returns_latest(self):
        snapshot = self.store.get_underlying_snapshot("SPY", "")
        self.assertEqual(snapshot["effectiveDate"], "2022-01-04")
        self.assertEqual(snapshot["requestedDate"], "")

    def test_underlying_snapshots_batch(self):
        snapshots = self.store.get_underlying_snapshots(
            "SPY", ["2022-01-03", "2022/01/05", "2022-01-03", "2001-01-01"]
        )
        self.assertEqual(set(snapshots), {"2022-01-03", "2022-01-05"})
        self.assertEqual(snapshots["2022-01-05"]["effectiveDate"], "2022-01-04")

    def test_underlying_daily_bars_shape(self):
        bars = self.store.get_underlying_daily_bars("SPY", "2022-01-01", "2022-12-31")
        self.assertEqual(len(bars), 2)
        first = bars[0]
        self.assertEqual(first["time"], "2022-01-03")
        self.assertEqual(first["open"], 476.0)
        self.assertEqual(first["volume"], 100000)
        self.assertIn("adjClose", first)
        self.assertIn("source", first)

    def test_option_snapshot_mark_from_bid_ask_midpoint(self):
        quote = self.store.get_option_snapshot(
            "SPY", "2022-01-03", "20220218", "P", 470
        )
        self.assertEqual(quote["bid"], 8.0)
        self.assertEqual(quote["ask"], 8.1)
        self.assertEqual(quote["mark"], 8.05)  # (8.0+8.1)/2
        self.assertEqual(quote["iv"], 0.20)
        self.assertEqual(quote["volume"], 50)
        self.assertEqual(quote["openInterest"], 2000)

    def test_option_snapshot_missing_returns_none(self):
        self.assertIsNone(
            self.store.get_option_snapshot("SPY", "2022-01-03", "20220218", "C", 999)
        )

    def test_option_snapshot_accepts_iso_expiry(self):
        quote = self.store.get_option_snapshot(
            "SPY", "2022/01/03", "2022-02-18", "put", "470"
        )
        self.assertIsNotNone(quote)

    def test_risk_free_rate_from_local_db(self):
        snapshot = self.store.get_risk_free_rate_snapshot("2022-01-04")
        self.assertEqual(snapshot["effectiveDate"], "2022-01-03")
        self.assertAlmostEqual(snapshot["rate"], 2 * math.log1p(0.0005 / 2))
        self.assertEqual(snapshot["source"], "treasury")
        self.assertTrue(snapshot["snapshotId"].startswith("usd-reference:"))

    def test_yield_curve_from_local_db(self):
        snapshot = self.store.get_yield_curve_snapshot("2022-01-04")
        self.assertEqual(snapshot["effectiveDate"], "2022-01-03")
        self.assertEqual(snapshot["schemaVersion"], 2)
        self.assertEqual(snapshot["kind"], "treasury_discount_curve")
        self.assertEqual([point["tenorDays"] for point in snapshot["points"]], [30, 3650])
        self.assertAlmostEqual(snapshot["points"][0]["inputParYield"], 0.0005)
        self.assertIn("legacy_rates_db_adapter", snapshot["quality"]["flags"])

    def test_rates_never_look_ahead_before_first_cached_observation(self):
        self.assertIsNone(self.store.get_risk_free_rate_snapshot("2022-01-02"))
        self.assertIsNone(self.store.get_yield_curve_snapshot("2022-01-02"))

    def test_unreachable_service_raises_chain_service_error(self):
        dead_store = HistoricalReplayStore(
            "http://127.0.0.1:9", self.rates_db, timeout=0.5
        )
        with self.assertRaises(ChainServiceError):
            dead_store.get_underlying_snapshot("SPY", "2022-01-03")


class SnapshotPayloadIntegrationTest(unittest.TestCase):
    """build_snapshot_payload end-to-end over the mock service."""

    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), MockChainServiceHandler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.tmpdir = tempfile.TemporaryDirectory()
        cls.rates_db = str(Path(cls.tmpdir.name) / "rates.db")
        build_rates_db(cls.rates_db)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmpdir.cleanup()

    def test_snapshot_payload(self):
        from historical_replay_service import HistoricalReplayService

        service = HistoricalReplayService(
            f"http://127.0.0.1:{self.port}", self.rates_db,
            yield_curve_data_dir=Path(self.tmpdir.name) / "yield_curve",
        )
        payload = service.build_snapshot_payload(
            "2022-01-03",
            {"symbol": "SPY"},
            [
                {"id": "leg1", "symbol": "SPY", "expDate": "20220218",
                 "right": "P", "strike": 470},
                {"id": "leg2", "symbol": "SPY", "expDate": "20220218",
                 "right": "C", "strike": 999},
            ],
        )
        self.assertEqual(payload["underlyingPrice"], 477.0)
        self.assertAlmostEqual(payload["riskFreeRate"], 2 * math.log1p(0.0005 / 2))
        self.assertEqual(payload["historicalReplay"]["effectiveDate"], "2022-01-03")
        self.assertEqual(
            payload["historicalReplay"]["availableStartDate"], "2008-01-02"
        )
        self.assertEqual(len(payload["historicalReplay"]["yieldCurvePoints"]), 2)
        self.assertEqual(payload["historicalReplay"]["discountCurve"]["schemaVersion"], 2)
        self.assertEqual(
            payload["historicalReplay"]["riskFreeRateSource"],
            payload["historicalReplay"]["yieldCurveSource"],
        )
        self.assertEqual(
            payload["historicalReplay"]["observedTradingDates"],
            ["2022-01-03", "2022-01-04"],
        )
        self.assertEqual(payload["options"]["leg1"]["mark"], 8.05)
        self.assertEqual(payload["options"]["leg2"], {"missing": True})


if __name__ == "__main__":
    unittest.main()
