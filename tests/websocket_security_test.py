import configparser
import unittest
from unittest import mock

import websockets

from websocket_security import (
    DEFAULT_ALLOWED_ORIGINS,
    read_allowed_ws_origins,
)


class WebSocketOriginConfigTests(unittest.TestCase):
    def setUp(self):
        environment = mock.patch.dict('os.environ', {}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)

    def _config(self, value=None):
        config = configparser.ConfigParser()
        config.add_section('server')
        if value is not None:
            config.set('server', 'allowed_origins', value)
        return config

    def test_defaults_are_loopback_http_origins(self):
        self.assertEqual(
            read_allowed_ws_origins(self._config()), DEFAULT_ALLOWED_ORIGINS)

    def test_parser_normalizes_and_deduplicates_exact_origins(self):
        result = read_allowed_ws_origins(self._config(
            'HTTP://LOCALHOST:8000/, http://localhost:8000, '
            'https://Example.COM:9443'))
        self.assertEqual(result, (
            'http://localhost:8000', 'https://example.com:9443'))

    def test_null_wildcard_path_and_empty_lists_fail_closed(self):
        for value in ('null', '*', 'http://*.example', 'http://bad host',
                      'http://localhost:8000/page', ' , '):
            with self.subTest(value=value), self.assertRaises(ValueError):
                read_allowed_ws_origins(self._config(value))

    def test_environment_overrides_config_for_container_deployments(self):
        with mock.patch.dict('os.environ', {
            'OPTION_COMBO_WS_ALLOWED_ORIGINS': 'http://ledger.example,http://localhost:8000',
        }):
            self.assertEqual(read_allowed_ws_origins(self._config()), (
                'http://ledger.example', 'http://localhost:8000'))

    def test_blank_environment_keeps_config(self):
        with mock.patch.dict('os.environ', {'OPTION_COMBO_WS_ALLOWED_ORIGINS': ' '}):
            self.assertEqual(read_allowed_ws_origins(self._config('http://ledger.example')),
                             ('http://ledger.example',))

    def test_invalid_environment_does_not_fall_back_to_config(self):
        with mock.patch.dict('os.environ', {'OPTION_COMBO_WS_ALLOWED_ORIGINS': '*'}):
            with self.assertRaises(ValueError):
                read_allowed_ws_origins(self._config())


class WebSocketOriginHandshakeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        async def handler(websocket):
            await websocket.send('accepted')

        allowed = read_allowed_ws_origins(None, env={
            'OPTION_COMBO_WS_ALLOWED_ORIGINS': 'http://ledger.example',
        })
        self.server = await websockets.serve(
            handler, '127.0.0.1', 0,
            origins=allowed,
        )
        port = self.server.sockets[0].getsockname()[1]
        self.uri = f'ws://127.0.0.1:{port}'

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()

    async def test_approved_origin_completes_the_handshake(self):
        async with websockets.connect(
                self.uri, origin='http://ledger.example') as websocket:
            self.assertEqual(await websocket.recv(), 'accepted')

    async def test_unlisted_origin_is_rejected_before_the_handler(self):
        with self.assertRaises(websockets.exceptions.InvalidStatus):
            async with websockets.connect(
                    self.uri, origin='https://attacker.example'):
                pass

    async def test_missing_origin_is_also_rejected(self):
        with self.assertRaises(websockets.exceptions.InvalidStatus):
            async with websockets.connect(self.uri):
                pass


class HistoricalServerOriginWiringTests(unittest.IsolatedAsyncioTestCase):
    async def test_historical_listener_passes_the_same_origin_allow_list(self):
        # Import must consume neither standing config nor a real chain service.
        with mock.patch.dict('os.environ', {}, clear=True), \
                mock.patch('configparser.ConfigParser.read', return_value=[]), \
                mock.patch('historical_data.HistoricalReplayStore.check_service',
                           return_value={'symbols': []}):
            import historical_server

        calls = []

        class StopAfterServe(Exception):
            pass

        async def fake_serve(*args, **kwargs):
            calls.append((args, kwargs))
            raise StopAfterServe()

        original = historical_server.websockets.serve
        historical_server.websockets.serve = fake_serve
        try:
            with self.assertRaises(StopAfterServe):
                await historical_server.main()
        finally:
            historical_server.websockets.serve = original
        self.assertEqual(len(calls), 1)
        self.assertEqual(
            calls[0][1]['origins'], historical_server.WS_ALLOWED_ORIGINS)


if __name__ == '__main__':
    unittest.main()
