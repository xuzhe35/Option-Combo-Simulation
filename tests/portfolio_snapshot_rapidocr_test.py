"""RapidOCR engine switch: server limits and the adapter's pixel rules on synthetic images.
The adapter tests need numpy/opencv/Pillow and are skipped where RapidOCR is not installed."""
import importlib.util
from importlib.util import find_spec
from pathlib import Path
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SERVER = load('snapshot_preview_engines', 'scripts/portfolio_snapshot_ocr_server.py')
ADAPTER = load('snapshot_rapidocr', 'scripts/portfolio_snapshot_rapidocr.py')
PIXELS = all(find_spec(name) is not None for name in ('numpy', 'cv2', 'PIL'))


def crop(field, x=0.1):
    return {'field': field, 'cropBbox': [x, 0.1, 0.05, 0.02]}


class ServerEngines(unittest.TestCase):
    def test_capabilities_name_all_three_engines(self):
        self.assertEqual(set(SERVER.engines()), {SERVER.VISION, SERVER.RAPIDOCR, SERVER.CODEX})

    def test_vision_reviews_every_numeric_cell_but_not_quantity(self):
        with self.assertRaises(SERVER.OcrError):
            SERVER.validate_crops([crop('quantity')], review=True)
        with self.assertRaises(SERVER.OcrError):
            SERVER.validate_crops([crop('mark')] * 1025, review=True)
        self.assertEqual(len(SERVER.validate_crops([crop('mark')] * 1024, review=True)), 1024)

    def test_rapidocr_reviews_every_numeric_cell_within_a_bound(self):
        crops = [crop('quantity')] + [crop('mark')] * 400
        self.assertEqual(SERVER.validate_crops(crops, review=True, engine=SERVER.RAPIDOCR), crops)
        for bad in ([crop('mark')] * 2049, [crop('unknownField')], [{'field': 'mark', 'cropBbox': [0.99, 0.1, 0.05, 0.02]}]):
            with self.assertRaises(SERVER.OcrError):
                SERVER.validate_crops(bad, review=True, engine=SERVER.RAPIDOCR)

    def test_rapidocr_is_the_default_engine_with_vision_as_fallback(self):
        cases = (((True, True), SERVER.RAPIDOCR), ((True, False), SERVER.VISION), ((False, True), SERVER.RAPIDOCR))
        for (vision, rapid), expected in cases:
            with mock.patch.object(SERVER, 'engines', return_value={SERVER.VISION: vision, SERVER.RAPIDOCR: rapid}):
                self.assertEqual(SERVER.default_engine(), expected)
        page = (ROOT / 'portfolio_snapshot.html').read_text(encoding='utf-8')
        self.assertIn('<option value="rapidocr" selected>', page)

    def test_missing_rapidocr_is_a_stated_unavailability(self):
        for status in ('package_missing', 'model_missing', 'model_invalid'):
            with mock.patch.object(SERVER, 'rapidocr_status', return_value=status), \
                    mock.patch.object(SERVER.shutil, 'which', return_value=None):
                with self.assertRaises(SERVER.OcrError) as raised:
                    SERVER.recognize(b'\x89PNG\r\n\x1a\n', '.png', engine=SERVER.RAPIDOCR)
                self.assertEqual(raised.exception.code, 'ocr_unavailable')
                self.assertIn('不会联网下载' if status != 'package_missing' else 'pip install', raised.exception.message)
                self.assertFalse(SERVER.engines()[SERVER.RAPIDOCR])
                self.assertIsNone(SERVER.default_engine())


class VerifierEngine(unittest.TestCase):
    def test_each_reply_must_come_from_the_requested_engine_and_protocol(self):
        verifier = load('snapshot_verifier', 'scripts/verify_portfolio_snapshot_ocr.py')
        verifier.check_engine({'engine': 'rapidocr', 'reviewProtocol': 2}, 'rapidocr', 'initial')
        verifier.check_engine({'engine': 'apple-vision', 'reviewProtocol': 1}, 'apple-vision', 'review')
        for reply, engine in (({'engine': 'apple-vision', 'reviewProtocol': 1}, 'rapidocr'),
                              ({'engine': 'rapidocr', 'reviewProtocol': 1}, 'rapidocr'),
                              ({'reviewProtocol': 2}, 'rapidocr')):
            with self.assertRaises(ValueError):
                verifier.check_engine(reply, engine, 'review')


class OfflineReadiness(unittest.TestCase):
    """Installed packages are not enough: every bundled model must match its pinned SHA-256."""

    def root(self, folder, models):
        import hashlib
        root = Path(folder)
        (root / 'models').mkdir()
        lines = []
        for name in ADAPTER.MODELS.values():
            body = ('model ' + name).encode()
            lines += [f'    model_dir: https://example.invalid/models/{name}', f'    SHA256: {hashlib.sha256(body).hexdigest()}']
            if name in models:
                (root / 'models' / name).write_bytes(models[name] if models[name] is not None else body)
        (root / 'default_models.yaml').write_text('\n'.join(lines) + '\n', encoding='utf-8')
        return root

    def test_ready_only_when_every_model_matches_its_pin(self):
        import tempfile
        names = list(ADAPTER.MODELS.values())
        with tempfile.TemporaryDirectory() as folder:
            status, digests = ADAPTER.model_status(self.root(folder, {n: None for n in names}))
            self.assertEqual(status, 'ready')
            self.assertEqual(set(digests), set(names))
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(ADAPTER.model_status(self.root(folder, {n: None for n in names[1:]})),
                             ('model_missing', {'model': names[0]}))
        with tempfile.TemporaryDirectory() as folder:
            altered = {n: None for n in names}
            altered[names[2]] = b'truncated'
            self.assertEqual(ADAPTER.model_status(self.root(folder, altered)), ('model_invalid', {'model': names[2]}))

    def test_engine_refuses_to_start_unless_ready(self):
        with mock.patch.object(ADAPTER, 'model_status', return_value=('model_missing', {'model': 'x.onnx'})), \
                mock.patch.object(ADAPTER, '_engine', None):
            with self.assertRaises(ADAPTER.ModelNotReady):
                ADAPTER.engine()

    def test_capabilities_report_the_rapidocr_status(self):
        from types import SimpleNamespace
        captured = []
        handler = SimpleNamespace(path='/api/capabilities', peer_allowed=lambda: True, respond=lambda status, body: captured.append(body))
        with mock.patch.object(SERVER, 'engines', return_value={SERVER.VISION: True, SERVER.RAPIDOCR: True, SERVER.CODEX: True}), \
                mock.patch.object(SERVER, 'rapidocr_status', return_value='ready'), \
                mock.patch.object(SERVER, 'codex_status', return_value='ready'), \
                mock.patch.object(SERVER, 'default_engine', return_value=SERVER.RAPIDOCR):
            SERVER.Handler.do_GET(handler)
        self.assertEqual(captured[0]['engineStatus'][SERVER.RAPIDOCR], 'ready')
        self.assertEqual(captured[0]['engineStatus'][SERVER.CODEX], 'ready')
        self.assertTrue(captured[0]['loopbackOnly'])
        self.assertFalse(captured[0]['localOnly'])
        self.assertEqual(captured[0]['engineProcessing'][SERVER.CODEX], 'cloud-via-local-cli')


@unittest.skipUnless(PIXELS, 'numpy / opencv / Pillow not installed')
class AdapterPixels(unittest.TestCase):
    def canvas(self, width=400, height=120):
        import numpy as np
        return np.full((height, width, 3), 24, dtype=np.uint8)

    def glyph(self, px, x, y, w=10, h=20, value=200):
        px[y:y + h, x:x + 2] = value
        px[y:y + 2, x:x + w] = value
        px[y + h - 2:y + h, x:x + w] = value

    def test_words_split_at_word_gaps_not_letter_gaps_and_dots_join_their_word(self):
        px = self.canvas()
        for x in (20, 34, 48):           # one word: 4 px letter spacing
            self.glyph(px, x, 40)
        for x in (90, 104):              # second word after a 32 px space
            self.glyph(px, x, 40)
        for x in (120, 126, 132):        # an ellipsis on the baseline
            px[57:60, x:x + 3] = 200
        boxes = ADAPTER.segments(px, (0, 30, 400, 70), True)
        self.assertEqual(len(boxes), 2)
        self.assertEqual((boxes[0][0], boxes[0][2]), (20, 58))
        self.assertEqual(boxes[1][2], 135)

    def test_status_square_is_colour_and_shape_while_grey_glyphs_never_qualify(self):
        px = self.canvas()
        px[50:58, 30:38] = (75, 120, 78)    # muted green 8x8 status mark
        px[40:60, 60:62] = 200              # grey glyph stroke
        self.assertTrue(ADAPTER.colored_square(px, (30, 50, 38, 58), 20))
        self.assertFalse(ADAPTER.colored_square(px, (60, 40, 62, 60), 20))
        px[40:60, 80:100] = (75, 120, 78)   # coloured, but a full glyph height tall
        self.assertFalse(ADAPTER.colored_square(px, (80, 40, 100, 60), 20))
        px[50:53, 120:135] = 230            # a minus sign with a coloured anti-aliased end
        px[50:53, 132:135] = (230, 120, 90)
        self.assertFalse(ADAPTER.colored_square(px, (120, 50, 135, 53), 20))

    def test_minus_sign_is_detected_from_pixels_even_when_one_pixel_tall(self):
        px = self.canvas()
        px[50, 20:26] = 200                 # one-pixel minus at mid-height
        self.glyph(px, 30, 40)
        rect = (10, 30, 80, 70)
        boxes = ADAPTER.segments(px, rect, False)
        box = (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))
        self.assertEqual(box[0], 20)        # the minus is inside the box sent to recognition
        self.assertTrue(ADAPTER.leading_dash(px, box, rect))
        plain = self.canvas()
        px[40:60, 100:102] = 200            # a leading '1' stroke is not a dash
        self.glyph(plain, 30, 40)
        self.assertFalse(ADAPTER.leading_dash(plain, (30, 40, 40, 60), rect))
        self.assertFalse(ADAPTER.leading_dash(px, (100, 40, 102, 60), (90, 30, 140, 70)))

    def test_full_height_rule_is_a_frame_line_but_a_glyph_is_not(self):
        px = self.canvas()
        px[:, 5:7] = 150
        self.glyph(px, 40, 50)
        self.assertTrue(ADAPTER.frame_line(px, (5, 50, 7, 70)))
        self.assertFalse(ADAPTER.frame_line(px, (40, 50, 42, 70)))

    def test_row_bands_follow_text_lines_and_ignore_a_vertical_rule(self):
        px = self.canvas(height=200)
        px[:, 3:5] = 150                    # tree / frame rule through every row
        for top in (20, 60, 100):
            for x in range(40, 200, 14):
                self.glyph(px, x, top)
        bands = ADAPTER.row_bands(px)
        self.assertEqual(bands, [[20, 40], [60, 80], [100, 120]])

    def test_review_reads_only_pixels_inside_the_requested_region(self):
        px = self.canvas()
        px[18:20, 40:60] = (255, 0, 0)   # previous row's ink just above the region
        px[41:43, 40:60] = (0, 0, 255)   # next row's ink just below it
        px[24:36, 44:56] = (0, 0, 0)     # the cell's own glyph
        seen = []

        class Result:
            txts, scores = ('8',), (0.99,)

        def fake(image, **_kwargs):
            seen.append(image)
            return Result()
        with mock.patch.object(ADAPTER, 'engine', return_value=fake):
            text, _conf, read = ADAPTER.recognize_box(px, (44, 24, 56, 36), 3, (30, 20, 70, 40), margin_ratio=0.5)
        self.assertEqual(text, '8')
        self.assertTrue(30 <= read[0] and 20 <= read[1] and read[2] <= 70 and read[3] <= 40)
        image = seen[0][:, :, ::-1]   # back to RGB
        self.assertFalse(((image[..., 0] > 200) & (image[..., 1] < 60) & (image[..., 2] < 60)).any())
        self.assertFalse(((image[..., 2] > 200) & (image[..., 0] < 60) & (image[..., 1] < 60)).any())

    def test_crop_requests_are_validated_before_reading(self):
        import tempfile
        from PIL import Image
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'blank.png'
            Image.fromarray(self.canvas()).save(path)
            for bad in ([{'field': 'mark', 'cropBbox': [0.9, 0.1, 0.2, 0.1]}], [{'field': 'note', 'cropBbox': [0.1, 0.1, 0.1, 0.1]}]):
                with self.assertRaises(ValueError):
                    ADAPTER.recognize(str(path), bad)


if __name__ == '__main__':
    unittest.main()
