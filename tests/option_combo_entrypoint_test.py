import configparser
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
ENTRYPOINT = REPO_ROOT / "option_combo_starter" / "entrypoint.sh"
CONFIG_OVERLAY = REPO_ROOT / "option_combo_starter" / "config_overlay.py"


class OptionComboEntrypointTests(unittest.TestCase):
    def _write_executable(self, path, text):
        path.write_text(text, encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def _fixture(self, *, marker_head="local-head", existing_checkout=True):
        temp_dir = tempfile.TemporaryDirectory()
        root = Path(temp_dir.name)
        repo_dir = root / "repo"
        upstream_config_text = (
            "[tws]\nhost = upstream\nport = 1111\nclient_id = 12\n"
            "team_setting = preserved\n"
            "[server]\nws_host = 127.0.0.1\nws_port = 9999\n"
            "[yield_curve]\ndata_dir = upstream-data\n"
            "[new_team_feature]\nenabled = yes\n"
        )
        upstream_config_source = root / "upstream-config.ini"
        upstream_config_source.write_text(upstream_config_text, encoding="utf-8")
        if existing_checkout:
            repo_dir.mkdir()
            (repo_dir / ".git").mkdir()
            (repo_dir / "ib_server.py").write_text("# synthetic\n", encoding="utf-8")
            (repo_dir / "config.ini").write_text(
                upstream_config_text,
                encoding="utf-8",
            )
        config_source = root / "config.ini"
        config_source.write_text(
            "[tws]\nhost = starter\nport = 7496\nclient_id = 999\n"
            "[server]\nws_host = 0.0.0.0\nws_port = 8765\n"
            "[yield_curve]\ndata_dir = /app/state/yield_curve\n"
            "auto_update_if_missing = false\n"
            "auto_update_if_stale = false\n"
            "[starter_only]\nignored = yes\n",
            encoding="utf-8",
        )
        marker = root / "setup-head"
        if marker_head is not None:
            marker.write_text(f"{marker_head}\n", encoding="utf-8")

        fake_bin = root / "bin"
        fake_bin.mkdir()
        command_log = root / "commands.log"
        self._write_executable(
            fake_bin / "git",
            """#!/usr/bin/env bash
set -eu
printf 'git %s\n' "$*" >> "$TEST_COMMAND_LOG"
case "$*" in
    *"clone "*)
        clone_target=""
        for argument in "$@"; do
            clone_target="$argument"
        done
        mkdir -p "$clone_target/.git"
        cp "$TEST_UPSTREAM_CONFIG_SOURCE" "$clone_target/config.ini"
        printf '# synthetic\n' > "$clone_target/ib_server.py"
        printf 'websockets\n' > "$clone_target/requirements-ib-bridge.txt"
        ;;
    *"rev-parse HEAD")
        printf '%s\n' "$TEST_LOCAL_HEAD"
        ;;
    *"ls-remote origin HEAD")
        if [ "${TEST_REMOTE_PROBE_FAIL:-0}" = "1" ]; then
            exit 1
        fi
        printf '%s\tHEAD\n' "$TEST_REMOTE_HEAD"
        ;;
    *"fetch origin")
        if [ "${TEST_FETCH_FAIL:-0}" = "1" ]; then
            exit 1
        fi
        ;;
    *"reset --hard origin/main")
        ;;
    *)
        exit 2
        ;;
esac
""",
        )
        self._write_executable(
            fake_bin / "timeout",
            """#!/usr/bin/env bash
set -eu
printf 'timeout %s\n' "$*" >> "$TEST_COMMAND_LOG"
case "$*" in
    *"git clone "*)
        if [ "${TEST_TIMEOUT_CLONE:-0}" = "1" ]; then
            clone_target=""
            for argument in "$@"; do
                clone_target="$argument"
            done
            mkdir -p "$clone_target/.git"
            printf 'partial clone\n' > "$clone_target/.git/incomplete"
            exit 124
        fi
        ;;
    *"ls-remote origin HEAD")
        if [ "${TEST_TIMEOUT_REMOTE_PROBE:-0}" = "1" ]; then
            exit 124
        fi
        ;;
    *"fetch origin")
        if [ "${TEST_TIMEOUT_FETCH:-0}" = "1" ]; then
            exit 124
        fi
        ;;
esac
while [ "$#" -gt 0 ]; do
    case "$1" in
        --signal=*|--kill-after=*)
            shift
            ;;
        *s)
            shift
            break
            ;;
        *)
            exit 98
            ;;
    esac
done
exec "$@"
""",
        )
        self._write_executable(
            fake_bin / "pip",
            """#!/usr/bin/env bash
set -eu
printf 'pip %s\n' "$*" >> "$TEST_COMMAND_LOG"
if [ "${TEST_PIP_FAIL:-0}" = "1" ]; then
    exit 17
fi
""",
        )
        self._write_executable(
            fake_bin / "python3",
            """#!/usr/bin/env bash
set -eu
printf 'python3 %s\n' "$*" >> "$TEST_COMMAND_LOG"
if [ "${1:-}" = "$TEST_CONFIG_OVERLAY_PATH" ]; then
    exec "$TEST_REAL_PYTHON" "$@"
fi
""",
        )

        env = {
            "PATH": f"{fake_bin}:/usr/bin:/bin",
            "HOME": str(root / "home"),
            "XDG_CONFIG_HOME": str(root / "xdg"),
            "OPTION_COMBO_REPO_DIR": str(repo_dir),
            "OPTION_COMBO_CONFIG_SOURCE": str(config_source),
            "OPTION_COMBO_CONFIG_OVERLAY_PATH": str(CONFIG_OVERLAY),
            "OPTION_COMBO_SETUP_MARKER": str(marker),
            "OPTION_COMBO_SUPERVISOR_PATH": str(root / "supervisor.py"),
            "TEST_COMMAND_LOG": str(command_log),
            "TEST_CONFIG_OVERLAY_PATH": str(CONFIG_OVERLAY),
            "TEST_LOCAL_HEAD": "local-head",
            "TEST_REMOTE_HEAD": "local-head",
            "TEST_REAL_PYTHON": sys.executable,
            "TEST_UPSTREAM_CONFIG_SOURCE": str(upstream_config_source),
        }
        return temp_dir, root, repo_dir, marker, command_log, env

    def _run_entrypoint(self, env):
        return subprocess.run(
            ["bash", str(ENTRYPOINT)],
            cwd=Path(env["HOME"]).parent,
            env=env,
            check=False,
            capture_output=True,
            text=True,
        )

    def test_remote_probe_failure_uses_valid_local_checkout(self):
        fixture = self._fixture()
        temp_dir, _root, _repo_dir, marker, command_log, env = fixture
        self.addCleanup(temp_dir.cleanup)
        env["TEST_REMOTE_PROBE_FAIL"] = "1"

        result = self._run_entrypoint(env)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(marker.read_text(encoding="utf-8").strip(), "local-head")
        commands = command_log.read_text(encoding="utf-8")
        self.assertIn("ls-remote origin HEAD", commands)
        self.assertNotIn("pip install", commands)
        self.assertIn("python3", commands)
        self.assertIn("using existing local checkout", result.stdout.lower())

    def test_remote_probe_timeout_uses_valid_local_checkout(self):
        fixture = self._fixture()
        temp_dir, _root, _repo_dir, marker, command_log, env = fixture
        self.addCleanup(temp_dir.cleanup)
        env["TEST_TIMEOUT_REMOTE_PROBE"] = "1"
        env["OPTION_COMBO_GIT_NETWORK_TIMEOUT_SECONDS"] = "7"

        result = self._run_entrypoint(env)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(marker.read_text(encoding="utf-8").strip(), "local-head")
        commands = command_log.read_text(encoding="utf-8")
        self.assertIn("--kill-after=5s 7s git", commands)
        self.assertIn("ls-remote origin HEAD", commands)
        self.assertNotIn("pip install", commands)
        self.assertIn("exceeded 7s", result.stdout)
        self.assertIn("python3", commands)

    def test_fetch_failure_uses_valid_local_checkout(self):
        fixture = self._fixture()
        temp_dir, _root, _repo_dir, marker, command_log, env = fixture
        self.addCleanup(temp_dir.cleanup)
        env["TEST_REMOTE_HEAD"] = "new-remote-head"
        env["TEST_FETCH_FAIL"] = "1"

        result = self._run_entrypoint(env)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(marker.read_text(encoding="utf-8").strip(), "local-head")
        commands = command_log.read_text(encoding="utf-8")
        self.assertIn("fetch origin", commands)
        self.assertNotIn("pip install", commands)
        self.assertIn("using existing local checkout", result.stdout.lower())

    def test_fetch_timeout_uses_valid_local_checkout_without_reset(self):
        fixture = self._fixture()
        temp_dir, _root, _repo_dir, marker, command_log, env = fixture
        self.addCleanup(temp_dir.cleanup)
        env["TEST_REMOTE_HEAD"] = "new-remote-head"
        env["TEST_TIMEOUT_FETCH"] = "1"

        result = self._run_entrypoint(env)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(marker.read_text(encoding="utf-8").strip(), "local-head")
        commands = command_log.read_text(encoding="utf-8")
        self.assertIn("--kill-after=5s 60s git", commands)
        self.assertIn("fetch origin", commands)
        self.assertNotIn("reset --hard origin/main", commands)
        self.assertNotIn("pip install", commands)
        self.assertIn("exceeded 60s", result.stdout)
        self.assertIn("python3", commands)

    def test_initial_clone_is_staged_then_completes_setup(self):
        fixture = self._fixture(marker_head=None, existing_checkout=False)
        temp_dir, _root, repo_dir, marker, command_log, env = fixture
        self.addCleanup(temp_dir.cleanup)

        result = self._run_entrypoint(env)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((repo_dir / ".git").is_dir())
        self.assertEqual(marker.read_text(encoding="utf-8").strip(), "local-head")
        self.assertEqual(
            list(repo_dir.parent.glob(f"{repo_dir.name}.clone.*")),
            [],
        )
        config = configparser.ConfigParser()
        config.read(repo_dir / "config.ini", encoding="utf-8")
        self.assertEqual(config.get("tws", "host"), "starter")
        self.assertEqual(config.get("tws", "team_setting"), "preserved")
        commands = command_log.read_text(encoding="utf-8")
        self.assertIn("--kill-after=5s 60s git clone", commands)
        self.assertIn("pip install --no-cache-dir", commands)
        self.assertIn("python3", commands)

    def test_initial_clone_timeout_fails_without_setup_or_marker(self):
        fixture = self._fixture(marker_head=None, existing_checkout=False)
        temp_dir, _root, repo_dir, marker, command_log, env = fixture
        self.addCleanup(temp_dir.cleanup)
        env["TEST_TIMEOUT_CLONE"] = "1"

        result = self._run_entrypoint(env)

        self.assertEqual(result.returncode, 124)
        self.assertFalse(repo_dir.exists())
        self.assertFalse(marker.exists())
        self.assertEqual(
            list(repo_dir.parent.glob(f"{repo_dir.name}.clone.*")),
            [],
        )
        commands = command_log.read_text(encoding="utf-8")
        self.assertIn("--kill-after=5s 60s git clone", commands)
        self.assertNotIn("pip install", commands)
        self.assertNotIn("python3", commands)
        self.assertIn("initial repository clone failed", result.stderr.lower())

    def test_missing_marker_runs_setup_and_writes_current_head(self):
        fixture = self._fixture(marker_head=None)
        temp_dir, _root, repo_dir, marker, command_log, env = fixture
        self.addCleanup(temp_dir.cleanup)

        result = self._run_entrypoint(env)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(marker.is_file())
        self.assertEqual(marker.read_text(encoding="utf-8").strip(), "local-head")
        self.assertTrue((repo_dir / "config.ini").is_file())
        config = configparser.ConfigParser()
        config.read(repo_dir / "config.ini", encoding="utf-8")
        self.assertEqual(config.get("tws", "host"), "starter")
        self.assertEqual(config.get("tws", "team_setting"), "preserved")
        self.assertEqual(config.get("new_team_feature", "enabled"), "yes")
        self.assertFalse(config.has_section("starter_only"))
        commands = command_log.read_text(encoding="utf-8")
        self.assertIn("pip install --no-cache-dir", commands)
        self.assertIn("python3", commands)

    def test_nonempty_environment_values_override_bundled_defaults(self):
        fixture = self._fixture(marker_head=None)
        temp_dir, _root, repo_dir, _marker, _command_log, env = fixture
        self.addCleanup(temp_dir.cleanup)
        env.update(
            {
                "TWS_HOST": "environment-host",
                "TWS_PORT": "",
                "TWS_CLIENT_ID": "42",
                "WS_HOST": "environment-ws-host",
                "WS_PORT": "8877",
                "YIELD_CURVE_DATA_DIR": "/persistent/yield-curve",
            }
        )

        result = self._run_entrypoint(env)

        self.assertEqual(result.returncode, 0, result.stderr)
        config = configparser.ConfigParser()
        config.read(repo_dir / "config.ini", encoding="utf-8")
        self.assertEqual(config.get("tws", "host"), "environment-host")
        self.assertEqual(config.get("tws", "port"), "7496")
        self.assertEqual(config.get("tws", "client_id"), "42")
        self.assertEqual(config.get("server", "ws_host"), "environment-ws-host")
        self.assertEqual(config.get("server", "ws_port"), "8877")
        self.assertEqual(
            config.get("yield_curve", "data_dir"),
            "/persistent/yield-curve",
        )
        self.assertFalse(
            config.getboolean("yield_curve", "auto_update_if_missing"),
        )
        self.assertFalse(
            config.getboolean("yield_curve", "auto_update_if_stale"),
        )
        self.assertEqual(config.get("tws", "team_setting"), "preserved")
        self.assertEqual(config.get("new_team_feature", "enabled"), "yes")

    def test_failed_config_overlay_does_not_write_completion_marker(self):
        fixture = self._fixture(marker_head=None)
        temp_dir, root, _repo_dir, marker, command_log, env = fixture
        self.addCleanup(temp_dir.cleanup)
        incomplete_defaults = root / "incomplete-defaults.ini"
        incomplete_defaults.write_text("[tws]\nhost = incomplete\n", encoding="utf-8")
        env["OPTION_COMBO_CONFIG_SOURCE"] = str(incomplete_defaults)

        failed = self._run_entrypoint(env)

        self.assertNotEqual(failed.returncode, 0)
        self.assertFalse(marker.exists())
        commands = command_log.read_text(encoding="utf-8")
        self.assertNotIn("pip install", commands)

    def test_failed_setup_does_not_write_marker_and_next_start_retries(self):
        fixture = self._fixture(marker_head=None)
        temp_dir, _root, _repo_dir, marker, command_log, env = fixture
        self.addCleanup(temp_dir.cleanup)
        env["TEST_PIP_FAIL"] = "1"

        failed = self._run_entrypoint(env)

        self.assertEqual(failed.returncode, 17)
        self.assertFalse(marker.exists())

        env.pop("TEST_PIP_FAIL")
        succeeded = self._run_entrypoint(env)

        self.assertEqual(succeeded.returncode, 0, succeeded.stderr)
        self.assertEqual(marker.read_text(encoding="utf-8").strip(), "local-head")
        commands = command_log.read_text(encoding="utf-8")
        self.assertEqual(commands.count("pip install --no-cache-dir"), 2)

    def test_failed_forced_rerun_removes_matching_old_completion_marker(self):
        fixture = self._fixture(marker_head="local-head")
        temp_dir, _root, _repo_dir, marker, _command_log, env = fixture
        self.addCleanup(temp_dir.cleanup)
        env["TEST_REMOTE_HEAD"] = "new-remote-head"
        env["TEST_PIP_FAIL"] = "1"

        failed = self._run_entrypoint(env)

        self.assertEqual(failed.returncode, 17)
        self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
