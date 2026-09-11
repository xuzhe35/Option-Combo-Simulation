"""Synthetic-only regressions for opt-in ledger access behind a LAN proxy."""

import configparser
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import cost_basis_ws


class Socket:
    def __init__(self, host):
        self.remote_address = (host, 51000)
        self.request_headers = {}
        self.sent = []

    async def send(self, message):
        self.sent.append(json.loads(message))


class TrustedLedgerPeerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.db = Path(self.scratch.name) / 'data' / 'ledger.db'
        # A developer's live DB-path override must never redirect this fixture.
        environment = mock.patch.dict('os.environ', {}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        self.config = configparser.ConfigParser(interpolation=None)
        self.config.read_dict({'cost_basis': {'db_path': str(self.db)}})

    def environment(self, peers=None):
        if peers is not None:
            self.config.set('cost_basis', 'trusted_peers', peers)
        return cost_basis_ws.create_store_env(self.config)

    async def request(self, env, host, action='request_cost_basis_status', **fields):
        socket = Socket(host)
        await cost_basis_ws.handle_cost_basis_action(
            env, socket, {'action': action, 'requestId': 'synthetic-request', **fields})
        return socket.sent[0]

    async def test_explicit_proxy_can_initialize_new_database(self):
        env = self.environment('192.0.2.10')
        self.assertFalse(self.db.exists())
        result = await self.request(env, '192.0.2.10')
        self.assertTrue(result['available'], result)
        self.assertTrue(self.db.is_file())

    async def test_default_remains_loopback_only(self):
        env = self.environment()
        result = await self.request(env, '192.0.2.10')
        self.assertEqual(result['reason'], 'remote_access_disabled')
        self.assertFalse(self.db.exists())
        self.assertIsNone(env['store'])

    async def test_environment_overrides_ini(self):
        self.config.set('cost_basis', 'trusted_peers', '192.0.2.11')
        with mock.patch.dict('os.environ', {
            'OPTION_COMBO_COST_BASIS_TRUSTED_PEERS': '192.0.2.10',
        }):
            env = self.environment()
        denied = await self.request(env, '192.0.2.11')
        self.assertEqual(denied['reason'], 'remote_access_disabled')
        self.assertFalse(self.db.exists())
        self.assertTrue((await self.request(env, '192.0.2.10'))['available'])

    async def test_empty_environment_revokes_ini_remote_access(self):
        with mock.patch.dict('os.environ', {'OPTION_COMBO_COST_BASIS_TRUSTED_PEERS': ''}):
            env = self.environment('192.0.2.10')
        self.assertEqual((await self.request(env, '192.0.2.10'))['reason'],
                         'remote_access_disabled')

    async def test_explicit_ipv4_and_ipv6_networks(self):
        env = self.environment('192.0.2.0/28,2001:db8:1::/64')
        for host in ('192.0.2.10', '::ffff:192.0.2.10', '2001:db8:1::10'):
            with self.subTest(host=host):
                self.assertTrue((await self.request(env, host))['available'])
        for host in ('192.0.2.16', '2001:db8:2::10'):
            with self.subTest(host=host):
                result = await self.request(env, host)
                self.assertEqual(result['reason'], 'remote_access_disabled')
                self.assertNotIn('storeSchemaVersion', result)

    async def test_mapped_ipv4_trusted_address_matches_normal_peer(self):
        env = self.environment('::ffff:192.0.2.10')
        self.assertTrue((await self.request(env, '192.0.2.10'))['available'])

    async def test_invalid_lists_deny_all_remote_but_keep_loopback(self):
        for value in ('*', '0.0.0.0/0', '::/0', 'proxy.example', '192.0.2.10/24',
                      '192.0.2.10,broken', '0.0.0.0', '224.0.0.1', '::',
                      '::ffff:0.0.0.0/96', '2001:db8::1%eth0'):
            with self.subTest(value=value):
                with self.assertLogs('cost_basis.ws', level='WARNING'):
                    env = self.environment(value)
                denied = await self.request(env, '192.0.2.10')
                self.assertEqual(denied['reason'], 'remote_access_disabled')
                self.assertTrue((await self.request(env, '127.0.0.1'))['available'])

    async def test_invalid_environment_does_not_reenable_ini(self):
        with mock.patch.dict('os.environ', {'OPTION_COMBO_COST_BASIS_TRUSTED_PEERS': '*'}):
            with self.assertLogs('cost_basis.ws', level='WARNING'):
                env = self.environment('192.0.2.10')
        self.assertFalse((await self.request(env, '192.0.2.10'))['available'])

    async def test_trusted_proxy_can_create_and_read_synthetic_book(self):
        env = self.environment('192.0.2.10')
        result = await self.request(env, '192.0.2.10', 'create_cost_basis_book',
                                    account='TEST-ACCOUNT', symbol='TEST',
                                    startDate='2026-01-01')
        self.assertTrue(result['success'], result)
        books = await self.request(env, '192.0.2.10', 'list_cost_basis_books')
        self.assertTrue(books['success'], books)
        self.assertEqual(len(books['books']), 1)

    async def test_forwarded_headers_cannot_grant_access(self):
        env = self.environment('192.0.2.10')
        socket = Socket('192.0.2.20')
        socket.request_headers = {'X-Forwarded-For': '192.0.2.10',
                                  'Forwarded': 'for=127.0.0.1'}
        await cost_basis_ws.handle_cost_basis_action(env, socket, {
            'action': 'request_cost_basis_status', 'requestId': 'synthetic-request'})
        self.assertEqual(socket.sent[0]['reason'], 'remote_access_disabled')
        self.assertFalse(self.db.exists())

    async def test_untrusted_broker_read_is_blocked_before_fetch(self):
        env = self.environment('192.0.2.10')
        response = await self.request(env, '192.0.2.20', 'request_cost_basis_executions')
        self.assertEqual(response['code'], 'remote_access_disabled')
        self.assertIsNone(env['store'])

    async def test_policy_does_not_relax_workspace_or_admin(self):
        import portfolio_admin_ws
        import portfolio_store_ws

        self.config.read_dict({'portfolio_store': {'db_path': str(self.db.parent / 'workspace.db')}})
        with mock.patch.dict('os.environ', {
            'OPTION_COMBO_COST_BASIS_TRUSTED_PEERS': '192.0.2.10',
        }):
            ledger = self.environment()
            workspace = portfolio_store_ws.create_store_env(self.config)
        self.assertTrue((await self.request(ledger, '192.0.2.10'))['available'])
        for handler, action in (
            (portfolio_store_ws.handle_persistence_action, 'request_workspace_store_status'),
            (portfolio_admin_ws.handle_admin_action, 'request_workspace_admin_status'),
        ):
            socket = Socket('192.0.2.10')
            await handler(workspace, socket, {'action': action, 'requestId': 'synthetic-request'})
            self.assertEqual(socket.sent[0].get('reason', socket.sent[0].get('code')),
                             'remote_access_disabled')
        self.assertIsNone(workspace['store'])


if __name__ == '__main__':
    unittest.main()
