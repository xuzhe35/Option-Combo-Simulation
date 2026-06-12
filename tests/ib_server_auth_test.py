import os
import pathlib
import stat
import sys
import tempfile
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


from ib_server_auth import (  # noqa: E402
    build_action_rejected_payload,
    build_allowed_origin_hosts,
    extract_origin_host,
    is_origin_allowed,
    load_or_create_token,
    resolve_auth_required,
    verify_token,
)


class TokenStorageTests(unittest.TestCase):
    def test_creates_token_on_first_run_and_reuses_it(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            token_path = os.path.join(tmp_dir, 'nested', 'ws_auth_token')

            first = load_or_create_token(token_path)
            second = load_or_create_token(token_path)

            self.assertTrue(first)
            self.assertGreaterEqual(len(first), 32)
            self.assertEqual(first, second)

    def test_token_file_is_owner_read_write_only(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            token_path = os.path.join(tmp_dir, 'ws_auth_token')
            load_or_create_token(token_path)

            mode = stat.S_IMODE(os.stat(token_path).st_mode)
            self.assertEqual(mode, 0o600)

    def test_regenerates_when_file_is_empty(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            token_path = os.path.join(tmp_dir, 'ws_auth_token')
            with open(token_path, 'w', encoding='utf-8') as handle:
                handle.write('   \n')

            token = load_or_create_token(token_path)
            self.assertTrue(token)

    def test_returns_empty_string_when_unwritable(self):
        token = load_or_create_token('/nonexistent-root-dir/deep/ws_auth_token')
        self.assertEqual(token, '')

    @unittest.skipUnless(os.name == 'posix', 'POSIX permission semantics')
    def test_tightens_permissive_mode_on_existing_token_file(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            token_path = os.path.join(tmp_dir, 'ws_auth_token')
            with open(token_path, 'w', encoding='utf-8') as handle:
                handle.write('existing-token\n')
            os.chmod(token_path, 0o644)

            token = load_or_create_token(token_path)

            self.assertEqual(token, 'existing-token')
            mode = stat.S_IMODE(os.stat(token_path).st_mode)
            self.assertEqual(mode, 0o600)

    def test_expands_user_home_in_path(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            original_home = os.environ.get('HOME')
            os.environ['HOME'] = tmp_dir
            try:
                token = load_or_create_token(os.path.join('~', '.option_combo_test', 'ws_auth_token'))
                expected = os.path.join(tmp_dir, '.option_combo_test', 'ws_auth_token')
                self.assertTrue(token)
                self.assertTrue(os.path.exists(expected))
            finally:
                if original_home is None:
                    os.environ.pop('HOME', None)
                else:
                    os.environ['HOME'] = original_home


class AuthRequirementTests(unittest.TestCase):
    def test_auto_mode_follows_bind_addresses(self):
        self.assertFalse(resolve_auth_required('auto', ['127.0.0.1']))
        self.assertFalse(resolve_auth_required('auto', ['localhost', '::1']))
        self.assertTrue(resolve_auth_required('auto', ['127.0.0.1', '100.64.1.2']))
        self.assertTrue(resolve_auth_required('auto', ['0.0.0.0']))

    def test_always_and_never_override_bind_addresses(self):
        self.assertTrue(resolve_auth_required('always', ['127.0.0.1']))
        self.assertFalse(resolve_auth_required('never', ['100.64.1.2']))

    def test_unknown_mode_falls_back_to_auto(self):
        self.assertTrue(resolve_auth_required('bogus', ['100.64.1.2']))
        self.assertFalse(resolve_auth_required('', ['127.0.0.1']))


class OriginAllowlistTests(unittest.TestCase):
    def test_allowed_hosts_include_loopback_bind_addresses_and_extras(self):
        allowed = build_allowed_origin_hosts(
            ['127.0.0.1', '100.64.1.2'],
            'my-desktop.tailnet.ts.net, Other.Example ',
        )
        for host in ('localhost', '127.0.0.1', '100.64.1.2', 'my-desktop.tailnet.ts.net', 'other.example'):
            self.assertIn(host, allowed)

    def test_origin_host_extraction(self):
        self.assertEqual(extract_origin_host('http://localhost:8000'), 'localhost')
        self.assertEqual(extract_origin_host('http://100.64.1.2:8000'), '100.64.1.2')
        self.assertEqual(extract_origin_host('HTTPS://Example.COM'), 'example.com')
        self.assertEqual(extract_origin_host('null'), '')
        self.assertEqual(extract_origin_host(''), '')

    def test_browser_origins_are_checked_but_missing_origin_passes(self):
        allowed = build_allowed_origin_hosts(['100.64.1.2'])

        # Non-browser clients (scripts) send no Origin; the token gates them.
        self.assertTrue(is_origin_allowed(None, allowed))
        self.assertTrue(is_origin_allowed('', allowed))

        self.assertTrue(is_origin_allowed('http://localhost:8000', allowed))
        self.assertTrue(is_origin_allowed('http://100.64.1.2:8000', allowed))
        self.assertFalse(is_origin_allowed('http://evil.example', allowed))
        self.assertFalse(is_origin_allowed('null', allowed))


class TokenVerificationTests(unittest.TestCase):
    def test_verify_token_requires_exact_match(self):
        self.assertTrue(verify_token('secret-token', 'secret-token'))
        self.assertFalse(verify_token('secret-token', 'secret-token '))
        self.assertFalse(verify_token('secret-token', 'other'))

    def test_empty_expected_token_never_authenticates(self):
        # Fail-closed: a server that could not create its token file must not
        # accept empty-for-empty matches.
        self.assertFalse(verify_token('', ''))
        self.assertFalse(verify_token('', 'anything'))
        self.assertFalse(verify_token(None, None))


class RejectionPayloadTests(unittest.TestCase):
    def test_combo_actions_reject_with_combo_error_shape(self):
        payload = build_action_rejected_payload(
            {'action': 'submit_combo_order', 'groupId': 'group_1'},
            'Authentication required.',
        )
        self.assertEqual(payload['action'], 'combo_order_error')
        self.assertEqual(payload['groupId'], 'group_1')
        self.assertEqual(payload['requestAction'], 'submit_combo_order')

    def test_hedge_actions_reject_with_hedge_error_shape(self):
        payload = build_action_rejected_payload(
            {'action': 'submit_hedge_order', 'hedgeId': 'delta_spy'},
            'Authentication required.',
        )
        self.assertEqual(payload['action'], 'hedge_order_error')
        self.assertEqual(payload['hedgeId'], 'delta_spy')

    def test_other_actions_reject_with_generic_auth_error(self):
        payload = build_action_rejected_payload(
            {'action': 'subscribe'},
            'Authentication required.',
        )
        self.assertEqual(payload['action'], 'auth_error')
        self.assertEqual(payload['requestAction'], 'subscribe')


if __name__ == '__main__':
    unittest.main()
