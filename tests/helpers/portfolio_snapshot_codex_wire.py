"""Offline native-CLI wire probe. No auth, external inference, or saved headers."""
import base64
import hashlib
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import tempfile
import threading


def capture(cli, model, catalog, image, mime='image/png', effort='high', detail='original', extra_images=None):
    from PIL import Image
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location('wire_transport', root / 'scripts/portfolio_snapshot_codex_transport.py')
    transport = importlib.util.module_from_spec(spec); spec.loader.exec_module(transport)
    captured = {}; ready = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        def log_message(self, *args): pass
        def do_GET(self):
            if self.headers.get('Upgrade', '').lower() != 'websocket':
                self.send_response(404); self.send_header('Content-Length', '0'); self.end_headers(); return
            accept = base64.b64encode(hashlib.sha1((self.headers['Sec-WebSocket-Key'] +
                '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
            self.send_response(101); self.send_header('Upgrade', 'websocket')
            self.send_header('Connection', 'Upgrade'); self.send_header('Sec-WebSocket-Accept', accept); self.end_headers()
            def send_obj(obj):
                b = json.dumps(obj).encode()
                head = bytes([0x81, len(b)]) if len(b) < 126 else bytes([0x81, 126]) + struct.pack('!H', len(b))
                self.wfile.write(head + b); self.wfile.flush()
            pending = b''
            try:
                for _ in range(20):
                    h = self.rfile.read(2)
                    if len(h) != 2 or h[0] & 15 == 8: return
                    n = h[1] & 127
                    if n == 126: n = struct.unpack('!H', self.rfile.read(2))[0]
                    elif n == 127: n = struct.unpack('!Q', self.rfile.read(8))[0]
                    if n > 16 * 1024 * 1024: raise ValueError('frame too large')
                    mask = self.rfile.read(4) if h[1] & 128 else None
                    b = self.rfile.read(n)
                    if mask: b = bytes(x ^ mask[i % 4] for i, x in enumerate(b))
                    pending += b
                    if not h[0] & 128: continue
                    if b'data:image/' in pending:
                        captured['request'] = json.loads(pending); ready.set(); return
                    pending = b''
                    # Acknowledge the native client's generate:false prewarm,
                    # then capture the real image request on the same socket.
                    r = {'id': 'resp_probe', 'object': 'response', 'model': model, 'output': [],
                        'usage': {'input_tokens': 0, 'output_tokens': 0, 'total_tokens': 0}}
                    send_obj({'type': 'response.created', 'response': dict(r, status='in_progress')})
                    send_obj({'type': 'response.completed', 'response': dict(r, status='completed')})
            except Exception as error:
                captured['error'] = str(error); ready.set()

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    connection = None
    try:
        with tempfile.TemporaryDirectory(prefix='portfolio-wire-') as folder:
            home, work = Path(folder) / 'home', Path(folder) / 'work'; home.mkdir(); work.mkdir()
            metadata = home / 'models.json'; metadata.write_text(json.dumps(catalog))
            (home / 'config.toml').write_text('\n'.join([
                'model = ' + json.dumps(model), 'model_provider = "openai"',
                'model_reasoning_effort = ' + json.dumps(effort),
                'model_catalog_json = ' + json.dumps(str(metadata)),
                'openai_base_url = ' + json.dumps(f'http://127.0.0.1:{server.server_port}/v1')]))
            env = dict(os.environ, CODEX_HOME=str(home), HTTP_PROXY='http://127.0.0.1:9',
                HTTPS_PROXY='http://127.0.0.1:9', ALL_PROXY='http://127.0.0.1:9', NO_PROXY='127.0.0.1,localhost')
            for key in ('OPENAI_API_KEY','OPENAI_BASE_URL','CODEX_API_KEY','CODEX_ACCESS_TOKEN'): env.pop(key, None)
            command = [cli, 'app-server']
            for flag in ('shell_tool','unified_exec','apps','plugins','multi_agent','browser_use',
                'computer_use','view_image','hooks','image_generation','memories'):
                command += ['--disable', flag]
            command += ['-c', 'web_search="disabled"']
            connection = transport.Connection(command, env, str(work), timeout=15)
            connection.call('initialize', {'clientInfo': {'name': 'portfolio_wire_test', 'version': '1'},
                'capabilities': {'experimentalApi': True}})
            connection.send({'method': 'initialized', 'params': {}})
            started = connection.call('thread/start', {'model': model, 'modelProvider': 'openai',
                'cwd': str(work), 'approvalPolicy': 'never', 'sandbox': 'read-only', 'ephemeral': True})
            assert started['reasoningEffort'] == effort and started['instructionSources'] == []
            connection.thread_id = started['thread']['id']
            url = 'data:' + mime + ';base64,' + base64.b64encode(image).decode()
            connection.image_url, connection.prompt, connection.detail = url, 'Wire diagnostic only.', detail
            content = [{'type': 'text', 'text': connection.prompt}, {'type': 'image', 'url': url, 'detail': detail}]
            for data, mime_type, label in extra_images or []:
                content += [{'type':'text','text':label},{'type':'image','url':'data:'+mime_type+';base64,'+base64.b64encode(data).decode(),'detail':'original'}]
            connection.expected_content = content
            connection.call('turn/start', {'threadId': connection.thread_id, 'model': model, 'effort': effort,
                'input': content})
            if not ready.wait(8): raise AssertionError('native wire image request not captured')
            if captured.get('error'): raise AssertionError(captured['error'])
            wire = captured['request']; images = []
            def walk(obj):
                if isinstance(obj, dict):
                    if obj.get('type') == 'input_image':
                        raw = base64.b64decode(obj['image_url'].split(',', 1)[1], validate=True)
                        im = Image.open(io.BytesIO(raw))
                        images.append({'detailOnWire': obj.get('detail'), 'width': im.width, 'height': im.height,
                            'sha256': hashlib.sha256(raw).hexdigest(), 'byteLength': len(raw)})
                    for value in obj.values(): walk(value)
                elif isinstance(obj, list):
                    for value in obj: walk(value)
            walk(wire)
            expected_images=[image]+[data for data,_,_ in extra_images or []]
            assert wire['model'] == model and wire['reasoning']['effort'] == effort and len(images) == len(expected_images)
            assert [i['sha256']for i in images] == [hashlib.sha256(b).hexdigest()for b in expected_images]
            return {'model': wire['model'], 'reasoningEffort': wire['reasoning']['effort'],
                'requestedDetail': detail, 'images': images, 'provider': 'openai', 'offlineOnly': True}
    finally:
        if connection is not None: connection.close()
        server.shutdown(); server.server_close()
