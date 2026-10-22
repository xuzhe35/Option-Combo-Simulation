"""Cross-platform RapidOCR adapter for the screenshot Portfolio page.

Emits the raw response format of scripts/portfolio_snapshot_vision.swift, so the
browser normalizer applies the same strict header, row-review and fail-closed rules
to either engine. RapidOCR reads tight single-line crops very reliably but its
detector boxes are coarse, so geometry here comes from pixels: words are split at
real ink gaps, and every crop is recognized on its own (recognition only).

It reports reviewProtocol 2: the normalizer then takes rows from the pixel row
bands below and adopts every numeric cell only when its 3x and 4x crops agree.

It runs offline only: the three bundled models must match the SHA-256 values the
installed RapidOCR release pins, and RapidOCR's own downloader is disabled here, so a
missing or altered model stops recognition instead of fetching anything.

Usage: python portfolio_snapshot_rapidocr.py IMAGE [CROPS.json]
Writes untrusted text plus normalized original-image boxes to stdout.
Exit 2: usage, 3: image or crop rejected, 4: models not ready, 1: recognition failed.
"""
from __future__ import annotations

import json
import logging
import math
import re
import sys
import unicodedata

MAX_EDGE, MAX_PIXELS, MAX_CANVAS, MAX_CROPS = 8192, 20_000_000, 8192, 2048
NUMERIC = re.compile(r'^[+-]?[0-9][0-9,.]*%?$')
REVIEW_FIELDS = ('quantity', 'descriptionRow', 'avgPrice', 'dailyPnl', 'mark', 'costBasis', 'unrealizedPnl',
                 'deltaDollars', 'marketValue', 'theta', 'lastPrice', 'displayIv')
MODELS = {'Det': 'PP-OCRv6_det_small.onnx', 'Cls': 'ch_ppocr_mobile_v2.0_cls_mobile.onnx', 'Rec': 'PP-OCRv6_rec_small.onnx'}
PACKAGES = ('rapidocr', 'onnxruntime', 'cv2', 'PIL', 'numpy')
_engine = None
_status_cache = {}


class ModelNotReady(Exception):
    pass


def package_root():
    from importlib.util import find_spec
    from pathlib import Path
    spec = find_spec('rapidocr')
    return Path(spec.origin).parent if spec and spec.origin else None


def pinned_hashes(root):
    """SHA-256 of each default model as pinned by the installed release's default_models.yaml."""
    text = (root / 'default_models.yaml').read_text(encoding='utf-8')
    return {name: digest for name, digest in re.findall(r'model_dir:\s*\S*/([^/\s]+)\s*\n\s*SHA256:\s*([0-9a-f]{64})', text)}


def model_status(root=None):
    """Offline readiness without loading the engine: 'ready', 'package_missing',
    'model_missing' or 'model_invalid', plus the checked model digests."""
    import hashlib
    from importlib.util import find_spec
    if root is None:
        if any(find_spec(name) is None for name in PACKAGES):
            return 'package_missing', {}
        root = package_root()
    try:
        pinned = pinned_hashes(root)
    except OSError:
        return 'model_invalid', {}
    digests = {}
    for name in MODELS.values():
        path = root / 'models' / name
        if not path.is_file():
            return 'model_missing', {'model': name}
        stat = path.stat()
        key = (str(path), stat.st_size, stat.st_mtime_ns)
        if key not in _status_cache:
            _status_cache[key] = hashlib.sha256(path.read_bytes()).hexdigest()
        if pinned.get(name) != _status_cache[key]:
            return 'model_invalid', {'model': name}
        digests[name] = _status_cache[key]
    return 'ready', digests


def available():
    return model_status()[0] == 'ready'


def engine():
    global _engine
    if _engine is None:
        status, detail = model_status()
        if status != 'ready':
            raise ModelNotReady(status + (':' + detail['model'] if 'model' in detail else ''))
        logging.disable(logging.WARNING)
        from rapidocr.utils.download_file import DownloadFile

        def refuse(*_args, **_kwargs):
            raise ModelNotReady('download_blocked')
        # Recognition never fetches models or dictionaries; any attempt is a readiness failure.
        DownloadFile.run = staticmethod(refuse)
        from rapidocr import RapidOCR
        root = package_root()
        _engine = RapidOCR(params={f'{task}.model_path': str(root / 'models' / name) for task, name in MODELS.items()})
    return _engine


def model_name():
    from importlib.metadata import version
    return 'rapidocr ' + version('rapidocr') + ' PP-OCRv6 small + pixel-segmented crops v1'


def load(path):
    from PIL import Image, ImageOps
    import numpy as np
    with Image.open(path) as image:
        width, height = image.size
        if not (0 < width <= MAX_EDGE and 0 < height <= MAX_EDGE and width * height <= MAX_PIXELS):
            raise ValueError('dimensions')
        upright = ImageOps.exif_transpose(image).convert('RGB')
    return np.ascontiguousarray(np.array(upright))


def letters(text):
    return ''.join(c for c in text.upper() if c.isalnum())


def ink_mask(region, neutral):
    """Contrast >= 120 to the dominant quantized colour. Neutral ink also requires a grey
    pixel (channel spread <= 90): TWS labels and contract names are grey/white, while
    neighbouring P&L cells and status marks are saturated."""
    import numpy as np
    pixels = region.astype(np.int32)
    quantized = pixels // 16
    keys = quantized[..., 0] * 256 + quantized[..., 1] * 16 + quantized[..., 2]
    key = int(np.bincount(keys.ravel()).argmax())
    background = np.array([(key // 256) * 16 + 8, ((key // 16) % 16) * 16 + 8, (key % 16) * 16 + 8])
    mask = np.abs(pixels - background).sum(axis=2) >= 120
    if neutral:
        mask &= (pixels.max(axis=2) - pixels.min(axis=2)) <= 90
    return mask


def segments(px, rect, neutral, header=False):
    """Word boxes (x0, y0, x1, y1) inside rect, split where the ink gap is wider than
    0.3 of the median glyph height (letter spacing in the TWS font stays well below it).
    Header labels need two ink pixels per column so a JPEG speck cannot bridge two labels;
    cells count every ink pixel, because a minus sign at small sizes is one pixel tall."""
    import numpy as np
    height, width = px.shape[:2]
    x0, y0 = max(0, int(rect[0])), max(0, int(rect[1]))
    x1, y1 = min(width, int(math.ceil(rect[2]))), min(height, int(math.ceil(rect[3])))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return []
    ink = ink_mask(px[y0:y1, x0:x1], neutral)
    if not header:
        # Inside a cell crop, a row inked across nearly the whole width is a cell edge or
        # rule and a column inked down nearly the whole height is a vertical rule; the crop
        # spans the gaps above and below the text, so glyphs never fill 90% of either.
        ink[ink.mean(axis=1) > 0.9, :] = False
        ink[:, ink.mean(axis=0) > 0.9] = False
    rows = np.nonzero(ink.sum(axis=1) >= 2)[0]
    if not len(rows):
        return []
    columns = ink.sum(axis=0) >= (2 if header else 1)
    runs, start = [], None
    for index, value in enumerate(list(columns) + [False]):
        if value and start is None:
            start = index
        elif not value and start is not None:
            runs.append([start, index]); start = None
    if not runs:
        return []
    # Spacing scales with the typical glyph height (median over ink runs), not with the
    # band, which tall marks such as a sort triangle would inflate.
    heights = sorted(int(np.ptp(np.nonzero(ink[:, a:b].any(axis=1))[0])) + 1 for a, b in runs)
    gap = max(3, heights[len(heights) // 2] * 0.3)
    words = []
    for run in runs:
        if words and run[0] - words[-1][1] <= gap:
            words[-1][1] = run[1]
        else:
            words.append(list(run))
    glyph = heights[len(heights) // 2]
    boxes = []
    for a, b in words:
        span = np.nonzero(ink[:, a:b].any(axis=1))[0]
        if not len(span) or (b - a) * len(span) < 4:
            continue
        box = (x0 + a, y0 + int(span[0]), x0 + b, y0 + int(span[-1]) + 1)
        # A mark far shorter than a glyph, on the same baseline and close behind a word, is
        # punctuation (an ellipsis); read it together with its word instead of on its own.
        if boxes and box[3] - box[1] <= glyph * 0.35 and abs(box[3] - boxes[-1][3]) <= glyph * 0.25 \
                and box[0] - boxes[-1][2] <= glyph * 1.5:
            last = boxes[-1]
            boxes[-1] = (last[0], min(last[1], box[1]), box[2], max(last[3], box[3]))
            continue
        boxes.append(box)
    return boxes


def frame_line(px, box):
    """A thin box whose columns stay ink-coloured from two text heights above to two below
    is a window or grid rule, not a glyph (glyphs are one text height tall)."""
    import numpy as np
    height, width = px.shape[:2]
    x0, y0, x1, y1 = box
    h = y1 - y0
    if h < 4 or x1 - x0 > max(3, h // 4):
        return False
    top, bottom = max(0, y0 - 2 * h), min(height, y1 + 2 * h)
    if bottom - top < 3 * h:
        return False
    column = px[top:bottom, x0:x1].astype(np.int32).mean(axis=1)
    # Compare with the background beside the line; at the image edge only one side exists.
    sides = [px[top:bottom, x - 1:x].astype(np.int32).mean(axis=1) for x in (x0 - 3, x1 + 4) if 1 <= x <= width]
    steady = (column.max(axis=0) - column.min(axis=0)).max() <= 24
    apart = bool(sides) and all(np.abs(column.mean(axis=0) - side.mean(axis=0)).sum() >= 30 for side in sides)
    return bool(steady and apart)


def colored_square(px, box, glyph):
    """A TWS status mark is a small, square, solid patch of colour. The segment itself must
    be square and mostly coloured: a minus sign is a long thin bar, and its slightly
    coloured anti-aliased fringe must never make it look like a mark."""
    import numpy as np
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    if not glyph or w < 3 or h < 3 or h > glyph * 0.6 or not 0.75 <= w / h <= 1.35:
        return False
    piece = px[y0:y1, x0:x1].astype(np.int32)
    colored = (piece.max(axis=2) >= 80) & ((piece.max(axis=2) - piece.min(axis=2)) >= 30)
    return bool(colored.sum() >= 0.6 * w * h)


def recognize_box(px, box, scale, bounds, margin_ratio=0.25):
    """Recognition only on one tight box enlarged by scale. Pixels are read strictly
    inside bounds (x0, y0, x1, y1, the requested region), so a neighbouring row or cell
    can never enter the recognizer; a margin the bounds cut off is filled with the crop's
    own background colour. A small margin keeps glyphs large after the recognizer's
    fixed-height resize, which stops repeated characters (000) from collapsing.
    Returns (text, confidence, read box in pixels) or None."""
    import cv2
    import numpy as np
    x0, y0, x1, y1 = box
    margin = max(2, int((y1 - y0) * margin_ratio))
    bx0, by0, bx1, by1 = (int(bounds[0]), int(bounds[1]), int(math.ceil(bounds[2])), int(math.ceil(bounds[3])))
    left, right = max(bx0, x0 - margin), min(bx1, x1 + margin)
    top, bottom = max(by0, y0 - margin), min(by1, y1 + margin)
    piece = px[top:bottom, left:right]
    if piece.size == 0:
        return None
    quantized = piece.astype(np.int32) // 16
    key = int(np.bincount((quantized[..., 0] * 256 + quantized[..., 1] * 16 + quantized[..., 2]).ravel()).argmax())
    background = tuple(int(v) for v in ((key // 256) * 16 + 8, ((key // 16) % 16) * 16 + 8, (key % 16) * 16 + 8))
    pad = (max(0, top - (y0 - margin)), max(0, (y1 + margin) - bottom), max(0, left - (x0 - margin)), max(0, (x1 + margin) - right))
    if any(pad):
        piece = cv2.copyMakeBorder(piece, *pad, cv2.BORDER_CONSTANT, value=background)
    if piece.shape[1] * scale + 24 > MAX_CANVAS or piece.shape[0] * scale + 12 > MAX_CANVAS:
        return None
    enlarged = cv2.resize(piece, (piece.shape[1] * scale, piece.shape[0] * scale), interpolation=cv2.INTER_CUBIC)
    enlarged = cv2.copyMakeBorder(enlarged, 6, 6, 12, 12, cv2.BORDER_CONSTANT, value=(0, 0, 0))
    result = engine()(np.ascontiguousarray(enlarged[:, :, ::-1]), use_det=False, use_cls=False, use_rec=True)
    # NFKC folds compatibility forms, e.g. the superscript last digit TWS uses for extra
    # price precision (1.23⁴ -> 1.234) and full-width punctuation; no digit is guessed.
    text = unicodedata.normalize('NFKC', result.txts[0] if result.txts else '').strip()
    return (text, float(result.scores[0]) if result.scores else 0.0, (left, top, right, bottom)) if text else None


def normalized(box, width, height):
    return [box[0] / width, box[1] / height, (box[2] - box[0]) / width, (box[3] - box[1]) / height]


def read_words(px, boxes, scale, limits, header=False, margin_ratio=0.25):
    """Recognize each box inside limits (x0, y0, x1, y1); a box that reads only as dots
    joins the previous word (an ellipsis is split from its word by its own spacing).
    Each word reports the pixels actually read (readBbox). Returns protocol words."""
    height, width = px.shape[:2]
    words = []
    for index, box in enumerate(boxes):
        if header and sort_triangle(px, box):
            words.append({'text': '▲', 'confidence': 1.0, '_box': box, '_read': box, 'coordinateEvidence': 'filled_sort_triangle'})
            continue
        left = (boxes[index - 1][2] + box[0]) // 2 if index else limits[0]
        right = (box[2] + boxes[index + 1][0] + 1) // 2 if index + 1 < len(boxes) else limits[2]
        read = recognize_box(px, box, scale, (left, limits[1], right, limits[3]), margin_ratio)
        if read is None:
            continue
        text, confidence, region = read
        if words and re.fullmatch(r'[.…]+', text):
            last = words[-1]
            last['text'] += text
            last['_box'] = (last['_box'][0], min(last['_box'][1], box[1]), box[2], max(last['_box'][3], box[3]))
            last['_read'] = tuple(f(a, b) for f, a, b in zip((min, min, max, max), last['_read'], region))
            continue
        words.append({'text': text, 'confidence': confidence, '_box': box, '_read': region})
    for word in words:
        box, region = word.pop('_box'), word.pop('_read')
        word['bbox'] = normalized(box, width, height)
        word['inkBbox'] = list(word['bbox'])
        word['readBbox'] = normalized(region, width, height)
    return words


def header_split(px, word_box, text, anchors):
    """Fused labels (e.g. LASTIMPLD): cut only at an ink gap near where body numbers
    right-align; adopt a cut only if both halves read the same at 2x and 3x and
    reconstruct the word. Never splits by character count."""
    height, width = px.shape[:2]
    if len(letters(text)) < 6:
        return None
    x0, y0, x1, y1 = word_box
    counts = ink_mask(px[y0:y1, x0:x1], True).sum(axis=0)
    cuts = set()
    for anchor in anchors:
        if x0 + (y1 - y0) * 0.5 < anchor < x1 - (y1 - y0) * 0.5:
            # Candidate cuts: at the alignment itself (adjacent labels may touch, e.g. a
            # crossbar running into a serif) and at the columns of least ink near it.
            window = [x for x in range(x0 + 1, x1 - 1) if abs(x - anchor) < (y1 - y0) * 0.65]
            if window:
                least = min(int(counts[x - x0]) for x in window)
                near = sorted((x for x in window if counts[x - x0] <= least + 1), key=lambda x: abs(x - anchor))
                cuts.update(near[:8])
                cuts.update(x for x in window if abs(x - anchor) <= 3)
    solutions = []
    for cut in sorted(cuts, key=lambda x: min(abs(x - anchor) for anchor in anchors)):
        parts = []
        for half in ((x0, y0, cut, y1), (cut, y0, x1, y1)):
            pieces = segments(px, half, True, header=True)
            if not pieces:
                break
            box = (min(p[0] for p in pieces), min(p[1] for p in pieces), max(p[2] for p in pieces), max(p[3] for p in pieces))
            reads = [recognize_box(px, box, scale, half) for scale in (2, 3)]
            if not all(reads) or reads[0][0] != reads[1][0] or len(letters(reads[0][0])) < 2:
                break
            parts.append({'text': reads[0][0], 'bbox': normalized(box, width, height),
                          'coordinateEvidence': 'body_alignment_crop_consensus', 'cutX': cut / width,
                          'passes': [{'scale': s, 'text': r[0]} for s, r in zip((2, 3), reads)]})
        if len(parts) == 2 and letters(parts[0]['text'] + parts[1]['text']) == letters(text):
            solutions.append(parts)
    return solutions or None


def sort_triangle(px, box):
    """Rows of a filled sort triangle widen (or narrow) steadily and have no hole."""
    import numpy as np
    x0, y0, x1, y1 = box
    ink = ink_mask(px[max(0, y0 - 1):y1 + 1, max(0, x0 - 1):x1 + 1], False)
    widths, holes = [], 0
    for row in ink:
        xs = np.nonzero(row)[0]
        if len(xs):
            widths.append(int(xs[-1] - xs[0] + 1))
            holes += len(xs) < xs[-1] - xs[0]
    if len(widths) < 5 or holes > 1 or abs(widths[0] - widths[-1]) < (x1 - x0) / 2:
        return False
    sign = 1 if widths[0] < widths[-1] else -1
    return sum(1 for a, b in zip(widths, widths[1:]) if (b - a) * sign >= -1) >= len(widths) - 2


def header_passes(px, words):
    """Two header reads (2x, 3x): neutral-ink word boxes, each recognized on its own."""
    height, width = px.shape[:2]
    instrument = next((w for w in words if 'INSTRUMENT' in letters(w['text'])), None)
    if not instrument:
        return []
    cy = instrument['bbox'][1] + instrument['bbox'][3] / 2
    row = [w for w in words if abs(w['bbox'][1] + w['bbox'][3] / 2 - cy) < min(w['bbox'][3], instrument['bbox'][3]) * 0.5]
    top, bottom = min(w['bbox'][1] for w in row), max(w['bbox'][1] + w['bbox'][3] for w in row)
    boxes = segments(px, (0, top * height, width, bottom * height), True, header=True)
    rules = [b for b in boxes if frame_line(px, b)]
    boxes = [b for b in boxes if b not in rules]
    numeric = sorted((w['bbox'][0] + w['bbox'][2]) * width for w in words if NUMERIC.match(w['text']) and w['bbox'][1] > bottom)
    clusters = []
    for x in numeric:
        if clusters and x - clusters[-1][0] <= (bottom - top) * height * 0.15:
            clusters[-1].append(x)
        else:
            clusters.append([x])
    anchors = [sum(c) / len(c) for c in clusters if len(c) >= 3]
    passes = []
    for scale in (2, 3):
        local = read_words(px, boxes, scale, (0, top * height, width, bottom * height), header=True)
        for word in local:
            b = word['bbox']
            box = (round(b[0] * width), round(b[1] * height), round((b[0] + b[2]) * width), round((b[1] + b[3]) * height))
            if word['text'].endswith('▲') and word['text'] != '▲':
                inner = segments(px, box, False, header=True)
                last = inner[-1] if inner else None
                if last and len(inner) >= 2 and sort_triangle(px, last):
                    split = last[0] / width
                    word['headerParts'] = [{'text': word['text'][:-1], 'bbox': [b[0], b[1], split - b[0], b[3]]},
                                           {'text': '▲', 'bbox': [split, b[1], b[0] + b[2] - split, b[3]],
                                            'coordinateEvidence': 'filled_sort_triangle'}]
            elif len(letters(word['text'])) >= 6:
                candidates = header_split(px, box, word['text'], anchors)
                if candidates:
                    word['headerPartCandidates'] = candidates
        passes.append({'scale': scale, 'words': local, 'excludedFrameLines': [normalized(b, width, height) for b in rules]})
    return passes


def review(px, field, rect, scales):
    """One requested crop, read as a single tight line (recognition keeps its context).
    Contract text is neutral ink; a narrow piece on the crop edge, apart from the rest,
    is the clipped end of a neighbouring cell. Numeric cells drop status squares."""
    if field == 'descriptionRow':
        boxes = [b for b in segments(px, rect, True) if not frame_line(px, b)]
        glyph = max((b[3] - b[1] for b in boxes), default=0)
        while len(boxes) > 1 and boxes[0][0] <= rect[0] + 1 and boxes[0][2] - boxes[0][0] <= glyph * 0.5:
            boxes = boxes[1:]
        while len(boxes) > 1 and boxes[-1][2] >= rect[2] - 1 and boxes[-1][2] - boxes[-1][0] <= glyph * 0.5:
            boxes = boxes[:-1]
    else:
        boxes = segments(px, rect, False)
        glyph = max((b[3] - b[1] for b in boxes), default=0)
        boxes = [b for b in boxes if not colored_square(px, b, glyph) and not frame_line(px, b)]
    if not boxes:
        # No glyph ink in the cell after removing rules and status marks: a blank cell.
        return [{'scale': scale, 'words': []} for scale in scales], True, False
    box = (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))
    passes = [{'scale': scale, 'words': read_words(px, [box], scale, rect, margin_ratio=0.1)}
              for scale in scales]
    return passes, False, leading_dash(px, box, rect)


def leading_dash(px, box, rect):
    """Pixel evidence for a minus sign, independent of recognition: scanning from the left,
    the first columns hold only a thin stroke in the middle of the glyph height, at least
    twice as long as it is thick, before the first digit rises. The background is judged
    on the whole cell, so a narrow digit is never taken for it."""
    import numpy as np
    x0, y0, x1, y1 = box
    cx0, cy0 = int(rect[0]), int(rect[1])
    cell = ink_mask(px[cy0:int(math.ceil(rect[3])), cx0:int(math.ceil(rect[2]))], False)
    cell[cell.mean(axis=1) > 0.9, :] = False
    cell[:, cell.mean(axis=0) > 0.9] = False
    ink = cell[y0 - cy0:y1 - cy0, x0 - cx0:x1 - cx0]
    glyph = y1 - y0
    thin = max(2, int(glyph * 0.2))
    top, bottom, length = None, None, 0
    for column in ink.T:
        rows = np.nonzero(column)[0]
        if not len(rows):
            if length:
                break
            continue
        low, high = int(rows[0]), int(rows[-1])
        new_top, new_bottom = (low, high) if top is None else (min(top, low), max(bottom, high))
        if new_bottom - new_top + 1 > thin:
            break
        top, bottom, length = new_top, new_bottom, length + 1
    if not length:
        return False
    middle = (top + bottom) / 2
    return bool(length >= 2 * (bottom - top + 1) and glyph * 0.3 <= middle <= glyph * 0.75)


def row_bands(px):
    """Text-line bands (top, bottom) in pixels from neutral ink. Columns that are ink on
    most rows (window or tree rules) and rows that are ink across most of the width
    (rules, selection outlines) are not text; a band needs several ink pixels per row, so
    a 1-2 px vertical rule cannot join neighbouring rows."""
    height, width = px.shape[:2]
    ink = ink_mask(px, True)
    ink[:, ink.mean(axis=0) > 0.6] = False
    ink[ink.mean(axis=1) > 0.5, :] = False
    rows = ink.sum(axis=1) >= max(6, width // 500)
    bands, start = [], None
    for y, value in enumerate(list(rows) + [False]):
        if value and start is None:
            start = y
        elif not value and start is not None:
            bands.append([start, y]); start = None
    if not bands:
        return []
    median = sorted(b[1] - b[0] for b in bands)[len(bands) // 2]
    merged = []
    for band in bands:
        if merged and band[0] - merged[-1][1] <= max(1, median * 0.25):
            merged[-1][1] = band[1]
        else:
            merged.append(list(band))
    return [b for b in merged if b[1] - b[0] >= median * 0.4]


def recognize(path, crops=None):
    px = load(path)
    height, width = px.shape[:2]
    words, lines, header, bands = [], [], [], []
    if crops is None:
        result = engine()(px[:, :, ::-1], return_word_box=True)
        for line_id, (box, text, score, word_results) in enumerate(zip(result.boxes if result.boxes is not None else [],
                                                                      result.txts or [], result.scores or [], result.word_results or [])):
            xs, ys = [float(p[0]) for p in box], [float(p[1]) for p in box]
            lines.append({'text': text, 'confidence': float(score),
                          'bbox': normalized((max(0.0, min(xs)), max(0.0, min(ys)), min(width, max(xs)), min(height, max(ys))), width, height)})
            for item in word_results:
                if len(item) != 3 or not item[0].strip():
                    continue
                token, confidence, quad = item
                qx, qy = [float(p[0]) for p in quad], [float(p[1]) for p in quad]
                b = (max(0.0, min(qx)), max(0.0, min(qy)), min(float(width), max(qx)), min(float(height), max(qy)))
                if b[2] > b[0] and b[3] > b[1]:
                    words.append({'text': token.strip(), 'confidence': float(confidence), 'bbox': normalized(b, width, height), 'lineId': line_id})
        header = header_passes(px, words)
        bands = [[top / height, bottom / height] for top, bottom in row_bands(px)]
    quantity_rereads, review_rereads = [], []
    for item in (crops or [])[:MAX_CROPS]:
        field = item.get('field') if isinstance(item, dict) else None
        b = item.get('cropBbox') if isinstance(item, dict) else None
        if field not in REVIEW_FIELDS or not isinstance(b, list) or len(b) != 4 \
                or not all(isinstance(v, (int, float)) and math.isfinite(v) and 0 <= v <= 1 for v in b) \
                or b[2] <= 0 or b[3] <= 0 or b[0] + b[2] > 1.000001 or b[1] + b[3] > 1.000001:
            raise ValueError('crop')
        rect = (round(b[0] * width), round(b[1] * height), min(width, round((b[0] + b[2]) * width)), min(height, round((b[1] + b[3]) * height)))
        passes, blank, dash = review(px, field, rect, [2, 3, 4] if field == 'descriptionRow' else [3, 4])
        evidence = {'field': field, 'cropBbox': normalized(rect, width, height), 'passes': passes, 'blank': blank}
        if field != 'descriptionRow':
            evidence['leadingDash'] = dash
        review_rereads.append(evidence)
        if field == 'quantity':
            quantity_rereads.append(evidence)
    return {'width': width, 'height': height, 'words': words, 'lines': lines, 'rereads': [], 'numericRereads': [],
            'headerRereads': header if len(header) == 2 else [], 'quantityRereads': quantity_rereads,
            'reviewRereads': review_rereads, 'rowBands': bands, 'reviewProtocol': 2, 'engine': 'rapidocr', 'model': model_name()}


def main():
    if len(sys.argv) not in (2, 3):
        sys.exit(2)
    try:
        crops = None
        if len(sys.argv) == 3:
            with open(sys.argv[2]) as handle:
                crops = json.load(handle)
            if not isinstance(crops, list):
                raise ValueError('crops')
        result = recognize(sys.argv[1], crops)
    except ModelNotReady as exc:
        sys.stderr.write('RapidOCR models not ready: ' + str(exc).split(':')[0] + '\n')
        sys.exit(4)
    except (ValueError, OSError):
        sys.exit(3)
    except Exception:
        # Never put image contents or local paths in diagnostics.
        sys.stderr.write('Local image recognition failed.\n')
        sys.exit(1)
    sys.stdout.write(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
