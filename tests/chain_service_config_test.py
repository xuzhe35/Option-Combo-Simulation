import configparser
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import chain_service_config as csc


def _config(text):
    parser = configparser.ConfigParser()
    parser.read_string(text)
    return parser


class ChainServiceUrlTest(unittest.TestCase):
    def setUp(self):
        for name in (csc.ENV_CHAIN_SERVICE_URL, csc.ENV_CHAIN_SERVICE_DIR):
            os.environ.pop(name, None)

    tearDown = setUp

    def test_falls_back_to_default_when_unconfigured(self):
        self.assertEqual(
            csc.resolve_chain_service_url(_config('[historical]\n')),
            'http://127.0.0.1:8750',
        )

    def test_config_value_wins_over_default(self):
        config = _config('[historical]\nchain_service_url = https://vendor.example/api\n')
        self.assertEqual(
            csc.resolve_chain_service_url(config),
            'https://vendor.example/api',
        )

    def test_env_wins_over_config(self):
        # The migration lever: point one run at another provider without
        # touching tracked config.
        config = _config('[historical]\nchain_service_url = http://127.0.0.1:8750\n')
        os.environ[csc.ENV_CHAIN_SERVICE_URL] = 'https://vendor.example/api'
        self.assertEqual(
            csc.resolve_chain_service_url(config),
            'https://vendor.example/api',
        )

    def test_trailing_slash_is_stripped_so_callers_can_concatenate_paths(self):
        config = _config('[historical]\nchain_service_url = https://vendor.example/api/\n')
        self.assertEqual(
            csc.resolve_chain_service_url(config),
            'https://vendor.example/api',
        )

    def test_blank_url_falls_back_rather_than_yielding_an_unusable_empty_url(self):
        config = _config('[historical]\nchain_service_url =\n')
        self.assertEqual(
            csc.resolve_chain_service_url(config),
            'http://127.0.0.1:8750',
        )

    def test_blank_env_cannot_leave_the_stack_with_nowhere_to_talk_to(self):
        # Deliberately asymmetric with chain_service_dir, where blank means
        # "remote". An empty url is never a usable answer, so it is skipped
        # and the next source wins.
        config = _config('[historical]\nchain_service_url = https://vendor.example/api\n')
        os.environ[csc.ENV_CHAIN_SERVICE_URL] = '   '
        self.assertEqual(
            csc.resolve_chain_service_url(config),
            'https://vendor.example/api',
        )


class ChainServiceDirTest(unittest.TestCase):
    def setUp(self):
        for name in (csc.ENV_CHAIN_SERVICE_URL, csc.ENV_CHAIN_SERVICE_DIR):
            os.environ.pop(name, None)

    tearDown = setUp

    def test_relative_config_resolves_against_the_repo_not_the_cwd(self):
        # The launchers cd around; a relative path must not mean different
        # directories depending on who invoked them.
        config = _config('[historical]\nchain_service_dir = ../sibling/chain_service\n')
        expected = os.path.normpath(
            os.path.join(csc.PROJECT_ROOT, '..', 'sibling', 'chain_service')
        )
        self.assertEqual(csc.resolve_chain_service_dir(config), expected)
        self.assertTrue(os.path.isabs(csc.resolve_chain_service_dir(config)))

    def test_absolute_config_is_used_as_is(self):
        config = _config('[historical]\nchain_service_dir = /opt/vendor/chain_service\n')
        self.assertEqual(
            csc.resolve_chain_service_dir(config),
            '/opt/vendor/chain_service',
        )

    def test_empty_dir_means_remote_and_is_honored_not_defaulted(self):
        # The vendor case: blanking the dir must NOT silently fall back to the
        # bundled default, or launchers would try to start a local server that
        # is not supposed to exist.
        config = _config('[historical]\nchain_service_dir =\n')
        self.assertEqual(csc.resolve_chain_service_dir(config), '')
        self.assertEqual(csc.resolve_chain_service_script(config), '')

    def test_missing_key_falls_back_to_the_bundled_sibling_layout(self):
        config = _config('[historical]\n')
        expected = os.path.normpath(
            os.path.join(csc.PROJECT_ROOT, '..', '..', 'Options DB', 'chain_service')
        )
        self.assertEqual(csc.resolve_chain_service_dir(config), expected)

    def test_env_wins_over_config(self):
        config = _config('[historical]\nchain_service_dir = /opt/from-config\n')
        os.environ[csc.ENV_CHAIN_SERVICE_DIR] = '/opt/from-env'
        self.assertEqual(csc.resolve_chain_service_dir(config), '/opt/from-env')

    def test_blank_env_switches_a_locally_configured_service_to_remote(self):
        # The vendor lever. The env var must be able to *clear* the dir, not
        # only set it, or you could never say "remote" without editing
        # tracked config.
        config = _config('[historical]\nchain_service_dir = ../../Options DB/chain_service\n')
        os.environ[csc.ENV_CHAIN_SERVICE_DIR] = ''
        self.assertEqual(csc.resolve_chain_service_dir(config), '')
        self.assertEqual(csc.resolve_chain_service_script(config), '')

    def test_script_path_is_the_dir_plus_chain_server(self):
        config = _config('[historical]\nchain_service_dir = /opt/vendor/chain_service\n')
        self.assertEqual(
            csc.resolve_chain_service_script(config),
            os.path.join('/opt/vendor/chain_service', 'chain_server.py'),
        )

    def test_script_path_is_returned_even_when_absent_on_disk(self):
        # Configured-but-missing is a different diagnosis from deliberately
        # remote, so this must not collapse to '' just because the file is gone.
        config = _config('[historical]\nchain_service_dir = /nonexistent/chain_service\n')
        self.assertNotEqual(csc.resolve_chain_service_script(config), '')


class ChainServiceCliTest(unittest.TestCase):
    """The bash and PowerShell launchers shell out to this, so the CLI contract
    matters as much as the Python one."""

    def _run(self, *args, env=None):
        merged = dict(os.environ)
        merged.pop(csc.ENV_CHAIN_SERVICE_URL, None)
        merged.pop(csc.ENV_CHAIN_SERVICE_DIR, None)
        merged.update(env or {})
        result = subprocess.run(
            [sys.executable, os.path.join(csc.PROJECT_ROOT, 'chain_service_config.py'), *args],
            capture_output=True, text=True, env=merged, cwd=csc.PROJECT_ROOT,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def test_url_matches_the_repo_config(self):
        self.assertEqual(self._run('--url'), csc.resolve_chain_service_url(csc.load_config()))

    def test_dir_matches_the_repo_config(self):
        self.assertEqual(self._run('--dir'), csc.resolve_chain_service_dir(csc.load_config()))

    def test_env_override_reaches_the_cli(self):
        self.assertEqual(
            self._run('--url', env={csc.ENV_CHAIN_SERVICE_URL: 'https://vendor.example/api'}),
            'https://vendor.example/api',
        )

    def test_remote_config_prints_an_empty_dir_for_the_launchers_to_branch_on(self):
        self.assertEqual(self._run('--dir', env={csc.ENV_CHAIN_SERVICE_DIR: ' '}), '')

    def test_resolving_does_not_depend_on_the_invoking_cwd(self):
        # Launchers cd to the repo, but scripts/CI may not.
        from_root = self._run('--dir')
        result = subprocess.run(
            [sys.executable, os.path.join(csc.PROJECT_ROOT, 'chain_service_config.py'), '--dir'],
            capture_output=True, text=True, cwd='/',
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), from_root)


if __name__ == '__main__':
    unittest.main()
