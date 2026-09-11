import ast
import configparser
from pathlib import Path
import unittest
from unittest import mock

import websockets

from websocket_security import (
    DEFAULT_ALLOWED_ORIGINS,
    read_allowed_ws_origins,
)


class LegacySupervisorOriginCompatibilityTests(unittest.TestCase):
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

    def test_helper_retains_nonempty_monitor_origin_for_shipped_images(self):
        self.assertEqual(
            read_allowed_ws_origins(self._config()), DEFAULT_ALLOWED_ORIGINS)
        self.assertEqual(read_allowed_ws_origins(None)[0], 'http://localhost:8000')

    def test_retired_config_is_ignored(self):
        result = read_allowed_ws_origins(self._config(
            'HTTP://LOCALHOST:8000/, http://localhost:8000, '
            'https://Example.COM:9443'))
        self.assertEqual(result, DEFAULT_ALLOWED_ORIGINS)

    def test_malformed_retired_config_cannot_block_supervisor_startup(self):
        for value in ('null', '*', 'http://*.example', 'http://bad host',
                      'http://localhost:8000/page', ' , '):
            with self.subTest(value=value):
                self.assertEqual(read_allowed_ws_origins(self._config(value)),
                                 DEFAULT_ALLOWED_ORIGINS)

    def test_retired_environment_is_ignored(self):
        with mock.patch.dict('os.environ', {
            'OPTION_COMBO_WS_ALLOWED_ORIGINS': 'http://ledger.example,http://localhost:8000',
        }):
            self.assertEqual(read_allowed_ws_origins(self._config()),
                             DEFAULT_ALLOWED_ORIGINS)

    def test_blank_environment_does_not_restore_config_policy(self):
        with mock.patch.dict('os.environ', {'OPTION_COMBO_WS_ALLOWED_ORIGINS': ' '}):
            self.assertEqual(read_allowed_ws_origins(self._config('http://ledger.example')),
                             DEFAULT_ALLOWED_ORIGINS)

    def test_malformed_retired_environment_cannot_block_supervisor_startup(self):
        with mock.patch.dict('os.environ', {'OPTION_COMBO_WS_ALLOWED_ORIGINS': '*'}):
            self.assertEqual(read_allowed_ws_origins(self._config()),
                             DEFAULT_ALLOWED_ORIGINS)
        self.assertEqual(read_allowed_ws_origins(None, env={
            'OPTION_COMBO_WS_ALLOWED_ORIGINS': '*',
        }), DEFAULT_ALLOWED_ORIGINS)


class WebSocketOriginHandshakeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        async def handler(websocket):
            await websocket.send('accepted')

        # Match both production listeners: omit origins entirely. The wiring
        # tests below guard this even without importing the broker entry point.
        self.server = await websockets.serve(
            handler, '127.0.0.1', 0,
        )
        port = self.server.sockets[0].getsockname()[1]
        self.uri = f'ws://127.0.0.1:{port}'

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()

    async def test_lan_page_origin_completes_the_handshake(self):
        async with websockets.connect(
                self.uri, origin='http://ledger.example') as websocket:
            self.assertEqual(await websocket.recv(), 'accepted')

    async def test_arbitrary_origin_completes_the_handshake(self):
        async with websockets.connect(
                self.uri, origin='https://unlisted.example') as websocket:
            self.assertEqual(await websocket.recv(), 'accepted')

    async def test_missing_origin_completes_the_handshake(self):
        async with websockets.connect(self.uri) as websocket:
            self.assertEqual(await websocket.recv(), 'accepted')

    async def test_null_origin_completes_the_handshake(self):
        async with websockets.connect(self.uri, origin='null') as websocket:
            self.assertEqual(await websocket.recv(), 'accepted')


class BackendOriginWiringTests(unittest.TestCase):
    def test_both_listeners_restore_unfiltered_origin_handshakes(self):
        root = Path(__file__).resolve().parents[1]
        for filename in ('ib_server.py', 'historical_server.py'):
            with self.subTest(backend=filename):
                # Parse only: importing the live backend would start broker work.
                tree = ast.parse((root / filename).read_text(encoding='utf-8'))
                listeners = [node for node in ast.walk(tree)
                             if isinstance(node, ast.Call)
                             and isinstance(node.func, ast.Attribute)
                             and isinstance(node.func.value, ast.Name)
                             and node.func.value.id == 'websockets'
                             and node.func.attr == 'serve']
                self.assertEqual(len(listeners), 1)
                keywords = {item.arg: item.value for item in listeners[0].keywords}
                self.assertNotIn('origins', keywords)
                self.assertIsInstance(keywords['max_size'], ast.Name)
                self.assertEqual(keywords['max_size'].id, 'MAX_WS_MESSAGE_BYTES')


class HistoricalServerOriginWiringTests(unittest.IsolatedAsyncioTestCase):
    async def test_historical_listener_does_not_filter_origins(self):
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
        self.assertNotIn('origins', calls[0][1])
        self.assertEqual(calls[0][1]['max_size'], historical_server.MAX_WS_MESSAGE_BYTES)


if __name__ == '__main__':
    unittest.main()
