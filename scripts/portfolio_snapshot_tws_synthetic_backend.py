#!/usr/bin/env python3
"""Synthetic TWS-position backend for the screenshot page's comparison checks
(CODE PLAN/PORTFOLIO_SNAPSHOT_TWS_CROSSCHECK_PLAN.md X4).

It answers only the three read snapshots the page's client may send, on 127.0.0.1, from
replies the browser assertion script sets. It never connects to TWS, refuses the live
backend's port 8765 and records every WebSocket action it receives, so the checks can prove
nothing else was sent.

The second port serves an allowlist only: the screenshot page and its assets, the assertion
script and the synthetic fixtures under tests/fixtures/portfolio_snapshot/tws/. "/" is a
blank page. Private folders are never served. Every response allows any origin, so a page
opened from file:// can load the assertion script and fixtures too.

    POST /__synthetic/scenario   {"accounts": reply|null, "positions": reply|null, "valuations": [reply]|null,
                                  "connectPush": [message], "dropOnPositions": bool}
                                 null means the backend stays silent; a positions reply gets the
                                 request's requestId; connectPush is sent on every new connection
    POST /__synthetic/reset      forget the action log and the scenario
    GET  /__synthetic/actions    {"actions": [...], "connections": n}

Usage:
    python3 scripts/portfolio_snapshot_tws_synthetic_backend.py --ws-port 8811 --http-port 8812
"""
import argparse
import asyncio
import http.server
import json
import pathlib
import threading

LIVE_PORT = 8765
REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
READ_ACTIONS = ('request_managed_accounts_snapshot', 'request_portfolio_positions_snapshot',
                'request_portfolio_avg_cost_snapshot')
STATIC = {'portfolio_snapshot.html', 'portfolio_snapshot.css', 'favicon.svg',
          'scripts/portfolio_snapshot_tws_browser_assertions.js'}
FIXTURES = 'tests/fixtures/portfolio_snapshot/tws/'
BLANK_PAGE = ('<!doctype html><meta charset="utf-8"><title>Synthetic TWS positions</title>'
              '<p>Synthetic TWS-position backend for tests. WebSocket port {port}. '
              '<a href="/portfolio_snapshot.html">portfolio_snapshot.html</a></p>')
LOCK = threading.Lock()
STATE = {'scenario': {}, 'actions': [], 'connections': 0}
TYPES = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
         '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml'}


def allowed(path):
    """Repository-relative path of an allowed static file, or None."""
    relative = path.lstrip('/')
    if '..' in relative.split('/') or '\\' in relative:
        return None
    if relative in STATIC or (relative.startswith('js/portfolio_snapshot') and relative.endswith('.js')
                              and '/' not in relative[3:]):
        return relative
    if relative.startswith(FIXTURES) and relative.endswith('.json'):
        return relative
    return None


class Site(http.server.BaseHTTPRequestHandler):
    ws_port = None

    def log_message(self, fmt, *args):
        pass

    def _send(self, status, body, content_type):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status, value):
        self._send(status, json.dumps(value).encode('utf-8'), 'application/json')

    def do_OPTIONS(self):  # noqa: N802 - http.server API
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):  # noqa: N802 - http.server API
        path = self.path.split('?', 1)[0]
        if path in ('/', '/index.html'):
            return self._send(200, BLANK_PAGE.format(port=self.ws_port).encode('utf-8'), 'text/html; charset=utf-8')
        if path == '/__synthetic/actions':
            with LOCK:
                return self._json(200, {'actions': list(STATE['actions']), 'connections': STATE['connections']})
        relative = allowed(path)
        if relative is None or not (REPO_ROOT / relative).is_file():
            return self._json(404, {'error': 'not served'})
        return self._send(200, (REPO_ROOT / relative).read_bytes(), TYPES.get(pathlib.Path(relative).suffix, 'application/octet-stream'))

    def do_POST(self):  # noqa: N802 - http.server API
        path = self.path.split('?', 1)[0]
        if path not in ('/__synthetic/scenario', '/__synthetic/reset'):
            return self._json(404, {'error': 'not found'})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
            if not isinstance(body, dict):
                raise ValueError('the body must be an object')
        except ValueError as exc:
            return self._json(400, {'error': str(exc)})
        with LOCK:
            if path == '/__synthetic/reset':
                STATE.update(scenario={}, actions=[], connections=0)
            else:
                STATE['scenario'] = body
        return self._json(200, {'ok': True})


async def handler(socket):
    with LOCK:
        STATE['connections'] += 1
        scenario = dict(STATE['scenario'])
    for message in scenario.get('connectPush') or []:
        await socket.send(json.dumps(message))
    async for raw in socket:
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        action = data.get('action') if isinstance(data, dict) else None
        with LOCK:
            STATE['actions'].append(action)
            scenario = dict(STATE['scenario'])
        if action not in READ_ACTIONS:
            continue  # recorded for the checks; a real backend would hand it to its order dispatcher
        if action == 'request_managed_accounts_snapshot' and scenario.get('accounts') is not None:
            await socket.send(json.dumps(scenario['accounts']))
        elif action == 'request_portfolio_positions_snapshot':
            if scenario.get('dropOnPositions'):
                await socket.close()
                return
            if scenario.get('positions') is not None:
                await socket.send(json.dumps({**scenario['positions'], 'requestId': data.get('requestId')}))
        elif action == 'request_portfolio_avg_cost_snapshot':
            for reply in scenario.get('valuations') or []:
                await socket.send(json.dumps(reply))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--ws-port', type=int, default=8811)
    parser.add_argument('--http-port', type=int, default=8812)
    args = parser.parse_args(argv)
    if LIVE_PORT in (args.ws_port, args.http_port):
        parser.error(f'port {LIVE_PORT} belongs to the live backend')
    import websockets

    site = http.server.ThreadingHTTPServer(('127.0.0.1', args.http_port), type('Site', (Site,), {'ws_port': args.ws_port}))
    threading.Thread(target=site.serve_forever, daemon=True).start()

    async def serve():
        async with websockets.serve(handler, '127.0.0.1', args.ws_port):
            print(f'synthetic TWS positions: ws 127.0.0.1:{args.ws_port}, site http://127.0.0.1:{args.http_port}', flush=True)
            await asyncio.Future()

    asyncio.run(serve())


if __name__ == '__main__':
    main()
