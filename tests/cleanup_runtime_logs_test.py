from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


def _load_cleanup_runtime_logs_module():
    project_root = Path(__file__).resolve().parents[1]
    module_path = project_root / "scripts" / "cleanup_runtime_logs.py"
    spec = importlib.util.spec_from_file_location("cleanup_runtime_logs", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


cleanup_runtime_logs = _load_cleanup_runtime_logs_module()


class CleanupRuntimeLogsTest(unittest.TestCase):
    def test_iter_targets_scans_logs_directory_and_legacy_root(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            runtime_dir = root / "logs"
            runtime_dir.mkdir()
            (runtime_dir / "http_server.codex.log").write_text("http\n", encoding="utf-8")
            (root / "ib_server.log").write_text("ib\n", encoding="utf-8")

            with mock.patch.object(cleanup_runtime_logs, "ROOT", root), \
                    mock.patch.object(cleanup_runtime_logs, "RUNTIME_DIR", runtime_dir):
                targets = cleanup_runtime_logs.iter_targets(include_active_pid=False)

            rel_paths = {target.path.relative_to(root).as_posix() for target in targets}
            self.assertIn("logs/http_server.codex.log", rel_paths)
            self.assertIn("ib_server.log", rel_paths)

    def test_iter_targets_skips_active_pid_and_matching_logs_by_default(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            runtime_dir = root / "logs"
            runtime_dir.mkdir()
            pid_file = runtime_dir / "ib_server.codex.pid"
            pid_file.write_text("43210\n", encoding="utf-8")
            (runtime_dir / "ib_server.codex.log").write_text("stdout\n", encoding="utf-8")
            (runtime_dir / "ib_server.codex.err.log").write_text("stderr\n", encoding="utf-8")

            with mock.patch.object(cleanup_runtime_logs, "ROOT", root), \
                    mock.patch.object(cleanup_runtime_logs, "RUNTIME_DIR", runtime_dir), \
                    mock.patch.object(cleanup_runtime_logs, "is_process_running", return_value=True):
                skipped_targets = cleanup_runtime_logs.iter_targets(include_active_pid=False)
                included_targets = cleanup_runtime_logs.iter_targets(include_active_pid=True)

            skipped_rel_paths = {
                target.path.relative_to(root).as_posix()
                for target in skipped_targets
            }
            included_rel_paths = {
                target.path.relative_to(root).as_posix()
                for target in included_targets
            }

            self.assertNotIn("logs/ib_server.codex.pid", skipped_rel_paths)
            self.assertNotIn("logs/ib_server.codex.log", skipped_rel_paths)
            self.assertNotIn("logs/ib_server.codex.err.log", skipped_rel_paths)

            self.assertIn("logs/ib_server.codex.pid", included_rel_paths)
            self.assertIn("logs/ib_server.codex.log", included_rel_paths)
            self.assertIn("logs/ib_server.codex.err.log", included_rel_paths)


if __name__ == "__main__":
    unittest.main()
