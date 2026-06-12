import asyncio
import json
import pathlib
import sys
import unittest
from types import SimpleNamespace


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


import historical_server  # noqa: E402


class _FakeWebSocket:
    def __init__(self, messages=None, remote_address=('127.0.0.1', 8765), origin=None):
        self._messages = list(messages or [])
        self.remote_address = remote_address
        self.sent = []
        self.close_calls = []
        if origin is not None:
            self.request = SimpleNamespace(headers={'Origin': origin})

    def __aiter__(self):
        self._iter = iter(self._messages)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration

    async def send(self, message):
        self.sent.append(json.loads(message))

    async def close(self, code=None, reason=None):
        self.close_calls.append((code, reason))


class HistoricalServerWsTests(unittest.TestCase):
    def test_rejects_disallowed_browser_origin(self):
        websocket = _FakeWebSocket(
            messages=[json.dumps({'action': 'request_portfolio_avg_cost_snapshot'})],
            origin='http://evil.example',
        )

        asyncio.run(historical_server.handle_ws_client(websocket))

        self.assertEqual(websocket.close_calls, [(4403, 'Origin not allowed')])
        self.assertEqual(websocket.sent, [])

    def test_serves_allowed_browser_origin(self):
        websocket = _FakeWebSocket(
            messages=[json.dumps({'action': 'request_portfolio_avg_cost_snapshot'})],
            origin='http://localhost:8000',
        )

        asyncio.run(historical_server.handle_ws_client(websocket))

        self.assertEqual(websocket.close_calls, [])
        self.assertEqual(
            websocket.sent,
            [{'action': 'portfolio_avg_cost_update', 'items': []}],
        )

    def test_serves_missing_origin_script_clients(self):
        websocket = _FakeWebSocket(
            messages=[json.dumps({'action': 'request_portfolio_avg_cost_snapshot'})],
        )

        asyncio.run(historical_server.handle_ws_client(websocket))

        self.assertEqual(websocket.close_calls, [])
        self.assertEqual(len(websocket.sent), 1)

    def test_enforces_token_auth_when_required(self):
        original_required = historical_server.AUTH_REQUIRED
        original_token = historical_server.AUTH_TOKEN
        try:
            historical_server.AUTH_REQUIRED = True
            historical_server.AUTH_TOKEN = 'replay-token'
            websocket = _FakeWebSocket(messages=[
                json.dumps({'action': 'request_portfolio_avg_cost_snapshot'}),
                json.dumps({'action': 'authenticate', 'token': 'wrong'}),
                json.dumps({'action': 'authenticate', 'token': 'replay-token'}),
                json.dumps({'action': 'request_portfolio_avg_cost_snapshot'}),
            ])

            asyncio.run(historical_server.handle_ws_client(websocket))

            actions = [payload.get('action') for payload in websocket.sent]
            self.assertEqual(actions[0], 'auth_status')
            self.assertIn('auth_error', actions)
            results = [p for p in websocket.sent if p.get('action') == 'auth_result']
            self.assertEqual([p['ok'] for p in results], [False, True])
            self.assertEqual(actions[-1], 'portfolio_avg_cost_update')
        finally:
            historical_server.AUTH_REQUIRED = original_required
            historical_server.AUTH_TOKEN = original_token

    def test_closes_after_repeated_failed_auth(self):
        original_required = historical_server.AUTH_REQUIRED
        original_token = historical_server.AUTH_TOKEN
        try:
            historical_server.AUTH_REQUIRED = True
            historical_server.AUTH_TOKEN = 'replay-token'
            bad_auth = json.dumps({'action': 'authenticate', 'token': 'wrong'})
            websocket = _FakeWebSocket(messages=[bad_auth] * 5)

            asyncio.run(historical_server.handle_ws_client(websocket))

            self.assertEqual(
                websocket.close_calls,
                [(4401, 'Too many failed authentication attempts')],
            )
        finally:
            historical_server.AUTH_REQUIRED = original_required
            historical_server.AUTH_TOKEN = original_token


if __name__ == '__main__':
    unittest.main()
