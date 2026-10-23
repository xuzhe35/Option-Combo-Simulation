"""Local image inspection/cropping and Portfolio JSON packaging; no OCR or network."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
from PIL import Image


def source(path):
    data = path.read_bytes()
    with Image.open(path) as image:
        image.load()
        if image.format not in ('PNG', 'JPEG'):
            raise ValueError('Only actual PNG/JPEG images are supported')
        if image.getexif().get(274, 1) != 1:
            raise ValueError('Rotate/export the image with orientation 1 before reading')
        w, h = image.size
        if len(data) > 4194304 or max(w, h) > 8192 or w * h > 20000000:
            raise ValueError('Image exceeds the existing page import limits; do not silently resize')
        return {'sourceId': 'image-1', 'sha256': hashlib.sha256(data).hexdigest(),
                'mimeType': Image.MIME[image.format], 'width': w, 'height': h,
                'fileName': path.name, 'recognitionRunId': None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest='action', required=True)
    for action in ('inspect', 'crop', 'build'):
        command = actions.add_parser(action)
        command.add_argument('--image', type=Path, required=True)
        if action == 'crop':
            command.add_argument('--output', type=Path, required=True)
        if action == 'crop':
            command.add_argument('--rect', type=int, nargs=4, required=True, metavar=('X', 'Y', 'W', 'H'))
        if action == 'build':
            command.add_argument('--output', type=Path, help='Default: beside image with .json extension')
            command.add_argument('--repo', type=Path, required=True)
            command.add_argument('--draft', type=Path, required=True)
            command.add_argument('--account')
            command.add_argument('--asof')
            command.add_argument('--node', default='node')
    args = parser.parse_args()
    info = source(args.image)
    if args.action == 'inspect':
        print(json.dumps(info, ensure_ascii=False, indent=2))
    elif args.action == 'crop':
        x, y, w, h = args.rect
        if min(x, y) < 0 or min(w, h) <= 0 or x + w > info['width'] or y + h > info['height']:
            raise ValueError('Crop is outside the source image')
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(args.image) as image, args.output.open('xb') as handle:
            image.crop((x, y, x + w, y + h)).save(handle, format='PNG')
        print(json.dumps({'output': str(args.output.resolve()), 'sourceSha256': info['sha256'],
                          'rect': args.rect, 'resized': False}, ensure_ascii=False))
    else:
        output = args.output or args.image.with_suffix('.json')
        payload = {'source': info, 'draftPath': str(args.draft.resolve()),
                   'account': args.account, 'asof': args.asof}
        result = subprocess.run([args.node, str(Path(__file__).with_name('build_portfolio.cjs')),
                                 str(args.repo.resolve()), str(output.resolve())],
                                input=json.dumps(payload), text=True,
                                capture_output=True)
        if result.returncode:
            raise ValueError(result.stderr.strip())
        print(result.stdout.strip())


if __name__ == '__main__':
    main()
