import configparser
import importlib.util
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock


REPO_ROOT = Path(__file__).resolve().parents[1]
HELPER_PATH = REPO_ROOT / "option_combo_starter" / "config_overlay.py"
SPEC = importlib.util.spec_from_file_location("option_combo_config_overlay", HELPER_PATH)
assert SPEC is not None and SPEC.loader is not None
CONFIG_OVERLAY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONFIG_OVERLAY)


def _read_ini(path):
    parser = configparser.ConfigParser(interpolation=None)
    parser.read(path, encoding="utf-8")
    return parser


class OptionComboConfigOverlayTests(unittest.TestCase):
    def _fixture(self):
        temp_dir = tempfile.TemporaryDirectory()
        root = Path(temp_dir.name)
        target = root / "runtime.ini"
        target.write_text(
            "[tws]\n"
            "Host = upstream-host\n"
            "port = 1111\n"
            "client_id = 12\n"
            "team_tws_setting = keep-tws\n"
            "\n"
            "[server]\n"
            "ws_host = 127.0.0.1\n"
            "ws_port = 9999\n"
            "team_server_setting = keep-server\n"
            "\n"
            "[yield_curve]\n"
            "data_dir = upstream-data\n"
            "auto_update_if_stale = false\n"
            "\n"
            "[new_team_feature]\n"
            "enabled = yes\n",
            encoding="utf-8",
        )
        target.chmod(0o640)
        defaults = root / "starter-defaults.ini"
        defaults.write_text(
            "[tws]\n"
            "host = starter-host\n"
            "port = 7496\n"
            "client_id = 999\n"
            "\n"
            "[server]\n"
            "ws_host = 0.0.0.0\n"
            "ws_port = 8765\n"
            "\n"
            "[yield_curve]\n"
            "data_dir = /app/state/yield_curve\n"
            "auto_update_if_stale = true\n"
            "\n"
            "[execution]\n"
            "starter_only_setting = must-not-be-copied\n",
            encoding="utf-8",
        )
        return temp_dir, root, target, defaults

    def test_overlays_only_whitelisted_keys_and_preserves_upstream_config(self):
        temp_dir, _root, target, defaults = self._fixture()
        self.addCleanup(temp_dir.cleanup)

        CONFIG_OVERLAY.overlay_config(
            target,
            defaults,
            {
                "TWS_HOST": "environment-host",
                "TWS_PORT": "",
                "WS_PORT": "8877",
            },
        )

        merged = _read_ini(target)
        self.assertEqual(merged.get("tws", "host"), "environment-host")
        self.assertEqual(merged.get("tws", "port"), "7496")
        self.assertEqual(merged.get("tws", "client_id"), "999")
        self.assertEqual(merged.get("server", "ws_host"), "0.0.0.0")
        self.assertEqual(merged.get("server", "ws_port"), "8877")
        self.assertEqual(
            merged.get("yield_curve", "data_dir"),
            "/app/state/yield_curve",
        )
        self.assertEqual(merged.get("tws", "team_tws_setting"), "keep-tws")
        self.assertEqual(
            merged.get("server", "team_server_setting"),
            "keep-server",
        )
        self.assertEqual(
            merged.get("yield_curve", "auto_update_if_stale"),
            "false",
        )
        self.assertEqual(merged.get("new_team_feature", "enabled"), "yes")
        self.assertFalse(merged.has_section("execution"))
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o640)

        preserved_case = CONFIG_OVERLAY._read_config(target)
        self.assertIn("Host", preserved_case["tws"])
        self.assertNotIn("host", preserved_case["tws"])

    def test_uses_atomic_replace_in_target_directory(self):
        temp_dir, root, target, defaults = self._fixture()
        self.addCleanup(temp_dir.cleanup)
        real_replace = os.replace
        replacements = []

        def recording_replace(source, destination):
            replacements.append((Path(source), Path(destination)))
            real_replace(source, destination)

        with mock.patch.object(
            CONFIG_OVERLAY.os,
            "replace",
            side_effect=recording_replace,
        ):
            CONFIG_OVERLAY.overlay_config(target, defaults, {})

        self.assertEqual(len(replacements), 1)
        temporary, destination = replacements[0]
        self.assertEqual(temporary.parent, root)
        self.assertEqual(destination, target)
        self.assertFalse(temporary.exists())

    def test_invalid_multiline_override_leaves_target_unchanged(self):
        temp_dir, root, target, defaults = self._fixture()
        self.addCleanup(temp_dir.cleanup)
        original = target.read_bytes()

        with self.assertRaises(CONFIG_OVERLAY.ConfigOverlayError):
            CONFIG_OVERLAY.overlay_config(
                target,
                defaults,
                {"TWS_HOST": "first-line\ninjected = value"},
            )

        self.assertEqual(target.read_bytes(), original)
        self.assertEqual(
            list(root.glob(f".{target.name}.*.tmp")),
            [],
        )

    def test_failed_atomic_replace_leaves_target_and_no_temporary_file(self):
        temp_dir, root, target, defaults = self._fixture()
        self.addCleanup(temp_dir.cleanup)
        original = target.read_bytes()

        with mock.patch.object(
            CONFIG_OVERLAY.os,
            "replace",
            side_effect=OSError("synthetic replace failure"),
        ):
            with self.assertRaises(CONFIG_OVERLAY.ConfigOverlayError):
                CONFIG_OVERLAY.overlay_config(target, defaults, {})

        self.assertEqual(target.read_bytes(), original)
        self.assertEqual(
            list(root.glob(f".{target.name}.*.tmp")),
            [],
        )

    def test_missing_required_default_leaves_target_unchanged(self):
        temp_dir, _root, target, defaults = self._fixture()
        self.addCleanup(temp_dir.cleanup)
        original = target.read_bytes()
        defaults.write_text("[tws]\nhost = incomplete\n", encoding="utf-8")

        with self.assertRaises(CONFIG_OVERLAY.ConfigOverlayError):
            CONFIG_OVERLAY.overlay_config(target, defaults, {})

        self.assertEqual(target.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
