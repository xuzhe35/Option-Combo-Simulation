"""TWS comparison (CODE PLAN/PORTFOLIO_SNAPSHOT_TWS_CROSSCHECK_PLAN.md X4): the page's assets are
served by the 8798 preview, and the synthetic test backend never reaches the live port, serves
only its allowlist and answers only the three read snapshots."""
import asyncio
import importlib.util
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SERVER = load('snapshot_preview_for_tws', 'scripts/portfolio_snapshot_ocr_server.py')
BACKEND = load('snapshot_tws_synthetic', 'scripts/portfolio_snapshot_tws_synthetic_backend.py')


class FakeSocket:
    def __init__(self, messages):
        self.messages, self.sent, self.closed = [json.dumps(m) if not isinstance(m, str) else m for m in messages], [], False

    def __aiter__(self):
        return self._iterate()

    async def _iterate(self):
        for message in self.messages:
            if self.closed:
                return
            yield message

    async def send(self, text):
        self.sent.append(json.loads(text))

    async def close(self):
        self.closed = True


class PageAssets(unittest.TestCase):
    def test_every_script_and_stylesheet_of_the_page_is_served_by_the_preview(self):
        html = (ROOT / 'portfolio_snapshot.html').read_text(encoding='utf-8')
        assets = re.findall(r'(?:src|href)="([^"?:]+\.(?:js|css))(?:\?[^"]*)?"', html)
        self.assertIn('js/portfolio_snapshot_tws_panel.js', assets)
        for asset in assets:
            self.assertIn(asset, SERVER.ASSETS, asset)


class SyntheticBackend(unittest.TestCase):
    def setUp(self):
        BACKEND.STATE.update(scenario={}, actions=[], connections=0)

    def test_the_live_backend_port_is_refused(self):
        for args in (['--ws-port', '8765'], ['--http-port', '8765']):
            with self.assertRaises(SystemExit):
                BACKEND.main(args)

    def test_only_the_page_its_assets_the_assertions_and_synthetic_fixtures_are_served(self):
        for path in ('/portfolio_snapshot.html', '/js/portfolio_snapshot_tws_panel.js', '/portfolio_snapshot.css',
                     '/scripts/portfolio_snapshot_tws_browser_assertions.js', '/tests/fixtures/portfolio_snapshot/tws/tws_replies.json'):
            self.assertIsNotNone(BACKEND.allowed(path), path)
        for path in ('/Portfolio SC/20261019.jpg', '/config.local.ini', '/config.ini', '/cost_basis.db',
                     '/tests/private_portfolio_snapshot/golden.json', '/tests/fixtures/portfolio_snapshot/tws/../../../../config.local.ini',
                     '/js/../config.local.ini', '/js/portfolio_snapshot_x/../../ib_server.py', '/js/pricing_core.js',
                     '/scripts/portfolio_snapshot_ocr_server.py', '/tests/fixtures/portfolio_snapshot/tws/drafts/x.txt', '/ib_server.py'):
            self.assertIsNone(BACKEND.allowed(path), path)

    def test_only_read_snapshots_are_answered_and_every_action_is_recorded(self):
        BACKEND.STATE['scenario'] = {'accounts': {'action': 'managed_accounts_update', 'accounts': ['U0000001']},
                                     'positions': {'action': 'portfolio_positions_snapshot', 'items': []},
                                     'valuations': [{'action': 'portfolio_avg_cost_update', 'items': []}],
                                     'connectPush': [{'action': 'managed_accounts_update', 'accounts': []}]}
        socket = FakeSocket([{'action': 'submit_combo_order'}, 'not json', {'action': 'request_managed_accounts_snapshot'},
                             {'action': 'request_portfolio_positions_snapshot', 'requestId': 'r-1'},
                             {'action': 'request_portfolio_avg_cost_snapshot'}])
        asyncio.run(BACKEND.handler(socket))
        self.assertEqual(BACKEND.STATE['actions'], ['submit_combo_order', 'request_managed_accounts_snapshot',
                                                    'request_portfolio_positions_snapshot', 'request_portfolio_avg_cost_snapshot'])
        self.assertEqual([m['action'] for m in socket.sent], ['managed_accounts_update', 'managed_accounts_update',
                                                              'portfolio_positions_snapshot', 'portfolio_avg_cost_update'])
        self.assertEqual(socket.sent[2]['requestId'], 'r-1')
        self.assertEqual(BACKEND.STATE['connections'], 1)

    def test_silence_and_a_dropped_connection_can_be_scripted(self):
        BACKEND.STATE['scenario'] = {'accounts': None, 'positions': None}
        quiet = FakeSocket([{'action': 'request_managed_accounts_snapshot'}, {'action': 'request_portfolio_positions_snapshot', 'requestId': 'q'}])
        asyncio.run(BACKEND.handler(quiet))
        self.assertEqual(quiet.sent, [])
        BACKEND.STATE['scenario'] = {'dropOnPositions': True, 'positions': {'action': 'portfolio_positions_snapshot', 'items': []}}
        dropped = FakeSocket([{'action': 'request_portfolio_positions_snapshot', 'requestId': 'd'}, {'action': 'request_managed_accounts_snapshot'}])
        asyncio.run(BACKEND.handler(dropped))
        self.assertTrue(dropped.closed)
        self.assertEqual(dropped.sent, [])


if __name__ == '__main__':
    unittest.main()
