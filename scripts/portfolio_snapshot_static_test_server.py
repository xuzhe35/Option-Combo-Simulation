"""Test-only static portal: the screenshot page remains usable with no OCR API."""
from http.server import ThreadingHTTPServer
from urllib.parse import urlsplit
from portfolio_snapshot_ocr_server import Handler, ROOT


class StaticPortal(Handler):
    def do_GET(self):
        if not self.peer_allowed():
            return self.respond(403, {'error': 'access_denied'})
        path = urlsplit(self.path).path
        if path.startswith('/api/'):
            return self.respond(404, {'error': 'static_only'})
        if path == '/cost_basis.html':
            return self.respond(200, (ROOT / 'cost_basis.html').read_bytes(), 'text/html; charset=utf-8')
        return super().do_GET()

    def do_POST(self):
        return self.respond(404, {'error': 'static_only'})


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', 8801), StaticPortal)
    server.daemon_threads = True
    print('Static-only test portal: http://127.0.0.1:8801', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
