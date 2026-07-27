import hashlib
import re
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
ENTRYPOINTS = (
    "index.html",
    "chart_lab.html",
    "iv_term_structure.html",
)


class StaticAssetCacheTest(unittest.TestCase):
    def test_market_holidays_uses_content_hash_cache_key(self):
        asset = PROJECT_ROOT / "js" / "market_holidays.js"
        expected = hashlib.sha256(asset.read_bytes()).hexdigest()[:12]
        pattern = re.compile(
            r'<script src="js/market_holidays\.js\?v=([^"]+)"></script>'
        )

        for relative_path in ENTRYPOINTS:
            with self.subTest(entrypoint=relative_path):
                html = (PROJECT_ROOT / relative_path).read_text(encoding="utf-8")
                match = pattern.search(html)
                self.assertIsNotNone(match)
                self.assertEqual(match.group(1), expected)


if __name__ == "__main__":
    unittest.main()
