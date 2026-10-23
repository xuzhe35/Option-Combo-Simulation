"""Isolated, loopback-only OCR preview server. No databases, broker or API keys.

Start: python3 scripts/portfolio_snapshot_ocr_server.py
Open: http://127.0.0.1:8798/portfolio_snapshot.html
Engines: offline 'apple-vision' (macOS) / 'rapidocr' (cross-platform), and explicit
'local-codex' (installed CLI with ChatGPT login; sends images to OpenAI's cloud model).
RapidOCR remains the default. The Codex module is independent of OCR calibration.
"""
from __future__ import annotations

import argparse
import atexit
import base64
import hashlib
import importlib.util
import ipaddress
import json
import math
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_BODY_BYTES = 6 * 1024 * 1024
SLOT = threading.BoundedSemaphore(1)
BUILD_DIRECTORY = tempfile.TemporaryDirectory(prefix='portfolio-ocr-build-')
atexit.register(BUILD_DIRECTORY.cleanup)
ASSETS = {'portfolio_snapshot.html', 'portfolio_snapshot.css', 'favicon.svg',
          'js/portfolio_snapshot_schema.js', 'js/portfolio_snapshot_core.js',
          'js/portfolio_snapshot_ocr.js', 'js/portfolio_snapshot_codex.js', 'js/portfolio_snapshot.js',
          'js/portfolio_snapshot_tws_model.js', 'js/portfolio_snapshot_tws.js', 'js/portfolio_snapshot_tws_panel.js'}
VISION, RAPIDOCR, CODEX = 'apple-vision', 'rapidocr', 'local-codex'
REVIEW_FIELDS = {'descriptionRow', 'avgPrice', 'dailyPnl', 'mark', 'costBasis', 'unrealizedPnl', 'deltaDollars',
                 'marketValue', 'theta', 'lastPrice', 'displayIv'}


_ADAPTER = None
_CODEX_ADAPTER = None
_CODEX_REVIEW = None
RAPIDOCR_MESSAGES = {
    'package_missing': 'RapidOCR 未安装：请在运行本服务的 Python 中执行 pip install rapidocr onnxruntime 后重启服务。',
    'model_missing': 'RapidOCR 模型文件缺失；识别时不会联网下载。请重新安装 rapidocr 后重启服务。',
    'model_invalid': 'RapidOCR 模型校验失败或不可离线使用；识别时不会联网下载。请重新安装 rapidocr 后重启服务。',
}


def rapidocr_adapter():
    """The adapter module; importing it loads only the standard library."""
    global _ADAPTER
    if _ADAPTER is None:
        spec = importlib.util.spec_from_file_location('portfolio_snapshot_rapidocr', ROOT / 'scripts/portfolio_snapshot_rapidocr.py')
        _ADAPTER = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_ADAPTER)
    return _ADAPTER


def rapidocr_status():
    """'ready', 'package_missing', 'model_missing' or 'model_invalid': installed packages
    alone are not enough; the bundled models must match their pinned SHA-256."""
    try:
        return rapidocr_adapter().model_status()[0]
    except (OSError, ValueError, ImportError):
        return 'model_invalid'


def codex_adapter():
    global _CODEX_ADAPTER
    if _CODEX_ADAPTER is None:
        spec = importlib.util.spec_from_file_location('portfolio_snapshot_codex', ROOT / 'scripts/portfolio_snapshot_codex.py')
        _CODEX_ADAPTER = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_CODEX_ADAPTER)
    return _CODEX_ADAPTER


def codex_status():
    try:
        return codex_adapter().status()
    except (OSError, ValueError, ImportError):
        return 'cli_unavailable'


def recognize_codex_review(image, suffix, request, engine):
    global _CODEX_REVIEW
    if engine != CODEX or not isinstance(request, dict) or set(request) != {'firstRunId'}:
        raise OcrError('codex_review_invalid', '局部复核请求或引擎无效。')
    if _CODEX_REVIEW is None:
        spec = importlib.util.spec_from_file_location('portfolio_codex_review', ROOT / 'scripts/portfolio_snapshot_codex_review.py')
        _CODEX_REVIEW = importlib.util.module_from_spec(spec); spec.loader.exec_module(_CODEX_REVIEW)
    adapter = codex_adapter()
    try:
        return _CODEX_REVIEW.recognize(image, suffix, request['firstRunId'], adapter)
    except adapter.CodexError as e:
        raise OcrError(e.code, e.message) from e


def engines():
    """Which engines this server can run; capability checks send no images."""
    return {VISION: sys.platform == 'darwin' and bool(shutil.which('swiftc')), RAPIDOCR: rapidocr_status() == 'ready',
            CODEX: codex_status() == 'ready'}


def default_engine():
    # RapidOCR's cell review is the default; Apple Vision remains selectable and is the
    # fallback where RapidOCR is not installed.
    available = engines()
    # Cloud-via-CLI is always an explicit selection, never an offline fallback.
    return RAPIDOCR if available[RAPIDOCR] else VISION if available[VISION] else None


class OcrError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


def loopback(host):
    if host == 'localhost':
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def decode_image(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get('image'), str):
        raise OcrError('image_invalid', '图片请求无效。')
    try:
        image = base64.b64decode(payload['image'], validate=True)
    except (ValueError, TypeError):
        raise OcrError('image_invalid', '图片编码无效。')
    if not image or len(image) > MAX_IMAGE_BYTES:
        raise OcrError('image_too_large', '图片需小于 4 MiB。')
    if image.startswith(b'\x89PNG\r\n\x1a\n'):
        suffix = '.png'
    elif image.startswith(b'\xff\xd8\xff'):
        suffix = '.jpg'
    else:
        raise OcrError('image_type_unsupported', '仅支持 PNG / JPEG 图片。')
    return image, suffix


def validate_crops(crops, review=False, engine=VISION):
    if crops is None:
        return None
    # RapidOCR reviews every numeric cell (quantity included); Vision reviews every numeric
    # cell except quantity, which keeps its own targeted crops.
    cell_review = review and engine == RAPIDOCR
    limit = 2048 if cell_review else 1024 if review else 64
    fields = REVIEW_FIELDS | {'quantity'} if cell_review else REVIEW_FIELDS if review else {'quantity'}
    if not isinstance(crops, list) or not 1 <= len(crops) <= limit:
        raise OcrError('crops_invalid', '局部重读区域无效。')
    for crop in crops:
        b = crop.get('cropBbox') if isinstance(crop, dict) else None
        if (not isinstance(b, list) or len(b) != 4 or crop.get('field') not in fields
                or not all(type(v) in (int, float) and math.isfinite(v) and 0 <= v <= 1 for v in b)
                or b[2] <= 0 or b[3] <= 0 or b[0] + b[2] > 1 or b[1] + b[3] > 1):
            raise OcrError('crops_invalid', '局部重读区域越界或格式无效。')
    return crops


def recognize_rapidocr(image, suffix, crops, review_crops):
    """Run the RapidOCR adapter in this server's Python, in a private temporary folder."""
    status = rapidocr_status()
    if status != 'ready':
        raise OcrError('ocr_unavailable', RAPIDOCR_MESSAGES.get(status, RAPIDOCR_MESSAGES['model_invalid']))
    with tempfile.TemporaryDirectory(prefix='portfolio-ocr-') as folder:
        work = Path(folder).resolve()
        target = work / ('image' + suffix)
        target.write_bytes(image)
        args = [sys.executable, str(ROOT / 'scripts/portfolio_snapshot_rapidocr.py'), str(target)]
        if crops is not None or review_crops is not None:
            regions = work / 'crops.json'
            regions.write_text(json.dumps((crops or []) + (review_crops or [])))
            args.append(str(regions))
        process = subprocess.run(args, capture_output=True, timeout=120)
        if process.returncode == 3:
            raise OcrError('image_dimensions_exceeded', '图片无法解码、超过 8192 像素 / 2000 万像素限制，或局部区域无效。')
        if process.returncode == 4:
            raise OcrError('ocr_unavailable', RAPIDOCR_MESSAGES['model_invalid'])
        if process.returncode:
            raise OcrError('ocr_failed', '本机 RapidOCR 识别未成功，请检查安装后重试。')
        result = json.loads(process.stdout)
        if not isinstance(result.get('words'), list) or len(result['words']) > 12000:
            raise OcrError('ocr_output_invalid', '识别结果结构无效。')
        return result


def recognize(image, suffix, crops=None, review_crops=None, engine=VISION):
    if engine == CODEX:
        if crops is not None or review_crops is not None:
            raise OcrError('crops_invalid', 'Codex 使用独立多模态协议，不接受 OCR 局部复读请求。')
        try:
            return codex_adapter().recognize(image, suffix)
        except codex_adapter().CodexError as exc:
            raise OcrError(exc.code, exc.message) from exc
    if engine not in (VISION, RAPIDOCR):
        raise OcrError('engine_invalid', '识别引擎无效。')
    crops = validate_crops(crops)
    review_crops = validate_crops(review_crops, review=True, engine=engine)
    if engine == RAPIDOCR:
        return recognize_rapidocr(image, suffix, crops, review_crops)
    if sys.platform != 'darwin' or not shutil.which('swiftc'):
        raise OcrError('ocr_unavailable', '本阶段的离线识别需要 macOS 与 Swift 命令行工具。图片、表格和 JSON 编辑仍可使用。')
    source = ROOT / 'scripts/portfolio_snapshot_vision.swift'
    # Cache only the compiled helper for this server's lifetime; images are short lived.
    build = Path(BUILD_DIRECTORY.name).resolve()
    binary = build / ('vision-ocr-' + hashlib.sha256(source.read_bytes()).hexdigest()[:16])
    if not binary.exists():
        subprocess.run([shutil.which('swiftc'), '-module-cache-path', str(build / 'modules'),
                        str(source), '-o', str(binary)], capture_output=True, timeout=65, check=True)
    # Everything is temporary and private to this server instance; no source images persist.
    with tempfile.TemporaryDirectory(prefix='portfolio-ocr-') as folder:
        work = Path(folder).resolve()
        target = work / ('image' + suffix)
        target.write_bytes(image)
        args = [str(binary), str(target)]
        if crops is not None or review_crops is not None:
            regions = work / 'crops.json'
            regions.write_text(json.dumps((crops or []) + (review_crops or [])))
            args.append(str(regions))
        process = subprocess.run(args, capture_output=True, timeout=110)
        if process.returncode == 3:
            raise OcrError('image_dimensions_exceeded', '图片无法解码，或超过 8192 像素 / 2000 万像素限制。')
        if process.returncode:
            raise OcrError('ocr_failed', '本机识别未成功。请从普通终端启动此服务后重试。')
        result = json.loads(process.stdout)
        if not isinstance(result.get('words'), list) or len(result['words']) > 12000:
            raise OcrError('ocr_output_invalid', '识别结果结构无效。')
        return result


class Handler(BaseHTTPRequestHandler):
    server_version = 'PortfolioPreview/1'

    def log_message(self, *_args):
        pass

    def peer_allowed(self):
        if not loopback(self.client_address[0]):
            return False
        try:
            host = urlsplit('http://' + self.headers.get('Host', '')).hostname
            origin = self.headers.get('Origin')
            return bool(host and loopback(host) and (not origin or
                (urlsplit(origin).scheme in ('http', 'https') and loopback(urlsplit(origin).hostname))))
        except (ValueError, TypeError):
            return False

    def respond(self, status, body, content_type='application/json; charset=utf-8'):
        if isinstance(body, dict):
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        if self.peer_allowed() and self.headers.get('Origin'):
            self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
            self.send_header('Vary', 'Origin')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # A canceled browser request must not print stack traces or retry a paid/cloud call.

    def do_OPTIONS(self):
        if not self.peer_allowed():
            return self.respond(403, {'error': 'access_denied'})
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin', 'http://127.0.0.1:8798'))
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Portfolio-Preview')
        self.end_headers()

    def do_GET(self):
        if not self.peer_allowed():
            return self.respond(403, {'error': 'access_denied'})
        path = urlsplit(self.path).path.lstrip('/') or 'portfolio_snapshot.html'
        if path == 'api/capabilities':
            available = engines()
            return self.respond(200, {'ocrAvailable': any(available.values()), 'engines': available,
                'engineStatus': {RAPIDOCR: rapidocr_status(), CODEX: codex_status()},
                'engine': default_engine(), 'localOnly': not available[CODEX], 'loopbackOnly': True,
                'engineProcessing': {VISION: 'offline', RAPIDOCR: 'offline', CODEX: 'cloud-via-local-cli'},
                'maxImageBytes': MAX_IMAGE_BYTES})
        if path not in ASSETS:
            return self.respond(404, {'error': 'not_found'})
        content_type = 'text/html; charset=utf-8' if path.endswith('.html') else (
            'text/css; charset=utf-8' if path.endswith('.css') else (
                'image/svg+xml' if path.endswith('.svg') else 'text/javascript; charset=utf-8'))
        self.respond(200, (ROOT / path).read_bytes(), content_type)

    def do_POST(self):
        if not self.peer_allowed():
            return self.respond(403, {'error': 'access_denied'})
        if urlsplit(self.path).path != '/api/recognize' or self.headers.get('X-Portfolio-Preview') != '1':
            return self.respond(404, {'error': 'not_found'})
        if self.headers.get_content_type() != 'application/json':
            return self.respond(415, {'error': 'content_type_invalid'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            size = 0
        if not 0 < size <= MAX_BODY_BYTES:
            return self.respond(413, {'error': 'image_too_large', 'message': '请求为空或超过大小限制。'})
        if not SLOT.acquire(blocking=False):
            return self.respond(429, {'error': 'ocr_busy', 'message': '正在识别另一张图片，请稍后重试。'})
        started = time.monotonic()
        try:
            payload = json.loads(self.rfile.read(size))
            image, suffix = decode_image(payload)
            engine = payload.get('engine') or default_engine()
            if engine not in (VISION, RAPIDOCR, CODEX):
                raise OcrError('engine_invalid', '识别引擎无效。')
            if 'codexReview' in payload:
                if 'quantityCrops' in payload or 'reviewCrops' in payload:
                    raise OcrError('codex_review_invalid', '不同复核协议不能混用。')
                result = recognize_codex_review(image, suffix, payload['codexReview'], engine)
            else:
                result = recognize(image, suffix, payload.get('quantityCrops'), payload.get('reviewCrops'), engine)
            result.update({'sourceHash': hashlib.sha256(image).hexdigest(), 'runId': secrets.token_hex(12),
                           'elapsedMs': round((time.monotonic() - started) * 1000)})
            self.respond(200, result)
        except OcrError as exc:
            self.respond(422, {'error': exc.code, 'message': exc.message})
        except subprocess.TimeoutExpired:
            self.respond(504, {'error': 'ocr_timeout', 'message': '本机识别超时，可缩小图片后重试。'})
        except (ValueError, KeyError, subprocess.SubprocessError, OSError):
            self.respond(422, {'error': 'ocr_failed', 'message': '图片识别失败，请检查本机 OCR 环境后重试。'})
        finally:
            SLOT.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8798)
    args = parser.parse_args()
    if args.port == 8765:
        parser.error('refuses the live broker port 8765')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.daemon_threads = True
    print(f'Portfolio OCR preview: http://127.0.0.1:{server.server_port}/portfolio_snapshot.html', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
