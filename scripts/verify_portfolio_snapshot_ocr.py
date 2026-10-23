"""Compare raw, unedited recognition with a private visual golden.

No cloud calls. --mode live contacts only a loopback OCR preview service.
Golden format: {positions: [{"instrument.symbol": "ABC", "quantity": "-3", ...}],
                sourceRows: 5, cash: [{currency: "USD", amount: "1234.5"}]}
"""
import argparse
import base64
import json
from pathlib import Path
import subprocess
import urllib.request
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def normalize(raw):
    code = """
const fs=require('node:fs');
const {loadBrowserScripts}=require('./tests/helpers/load-browser-scripts');
const c=loadBrowserScripts(['js/portfolio_snapshot_schema.js','js/portfolio_snapshot_core.js','js/portfolio_snapshot_ocr.js','js/portfolio_snapshot_codex.js']);
try {
const raw=JSON.parse(fs.readFileSync(0,'utf8'));
const normalized=raw.engine==='local-codex'&&raw.localReviewReply
    ? c.OptionComboPortfolioSnapshotCodex.combine(raw,raw.localReviewReply,'image-1')
    : (raw.engine==='local-codex'?c.OptionComboPortfolioSnapshotCodex:c.OptionComboPortfolioSnapshotOcr).normalize(raw,'image-1');
c.OptionComboPortfolioSnapshotCore.applyRecognition(c.OptionComboPortfolioSnapshotSchema.empty('evaluation','test'),normalized);
process.stdout.write(JSON.stringify(normalized));
} catch (e) { process.stdout.write(JSON.stringify({normalizationError:e.message})); }
"""
    result = subprocess.run(['node', '-e', code], input=json.dumps(raw).encode(), capture_output=True, cwd=ROOT, check=True)
    value = json.loads(result.stdout)
    if value.get('normalizationError'):
        raise ValueError(value['normalizationError'])
    return value


def compare(actual, golden):
    fields, differences = {}, []
    for index, expected in enumerate(golden['positions']):
        position = actual['positions'][index] if index < len(actual['positions']) else {}
        for path, expected_value in expected.items():
            value = position
            for key in path.split('.'):
                value = value.get(key) if isinstance(value, dict) else None
            counter = fields.setdefault(path, {'correct': 0, 'total': 0})
            counter['total'] += 1
            if value == expected_value:
                counter['correct'] += 1
            else:
                differences.append({'row': index + 1, 'field': path, 'expected': expected_value, 'actual': value})
    combos = [{'parentRowNumber': actual['sourceRows'].index(r) + 1,
               'legRowNumbers': [next(i + 1 for i, row in enumerate(actual['sourceRows']) if row['rowId'] == leg)
                                 for leg in r.get('combo', {}).get('atomicLegRowIds', [])]}
              for r in actual['sourceRows'] if r['rowType'] == 'combo_summary']
    hierarchy_matches = 'combos' not in golden or combos == golden['combos']
    structure_matches = 'structureIssueCount' not in golden or len(actual['recognition'].get('structureIssues', [])) == golden['structureIssueCount']
    first_pass_differences = []
    for index, expected in enumerate(golden['positions']):
        if index >= len(actual['positions']):
            continue
        evidence = actual['positions'][index].get('fieldEvidence', {})
        for path, value in expected.items():
            if path in evidence and evidence[path].get('originalValue') != value:
                first_pass_differences.append({'row': index + 1, 'field': path, 'expected': value,
                                               'firstPass': evidence[path].get('originalValue')})
    return {'positionCount': {'actual': len(actual['positions']), 'expected': len(golden['positions'])},
        'sourceRowCount': {'actual': len(actual['sourceRows']), 'expected': golden['sourceRows']},
        'comboHierarchy': combos, 'comboHierarchyMatches': hierarchy_matches,
        'structureMatches': structure_matches, 'firstPassDifferences': first_pass_differences,
        'refinementCount': len(actual['recognition'].get('refinements', [])),
        'cashMatches': [{k: row.get(k) for k in ('currency', 'amount')} for row in actual['cash']] == golden['cash'],
        'fields': fields, 'differences': differences,
        'nonNullFields': {'correct': sum(1 for i,p in enumerate(golden['positions']) for k,v in p.items() if v is not None and not any(d['row']==i+1 and d['field']==k for d in differences)), 'total': sum(v is not None for p in golden['positions'] for v in p.values())},
        'unknownFields': {'correct': sum(1 for i,p in enumerate(golden['positions']) for k,v in p.items() if v is None and not any(d['row']==i+1 and d['field']==k for d in differences)), 'total': sum(v is None for p in golden['positions'] for v in p.values())},
        'rowTypesChecked': 'rowTypes' in golden,
        'rowTypesMatch': [r['rowType'] for r in actual['sourceRows']] == golden.get('rowTypes', [r['rowType'] for r in actual['sourceRows']]),
        'allMatched': not differences and hierarchy_matches and structure_matches
            and [r['rowType'] for r in actual['sourceRows']] == golden.get('rowTypes', [r['rowType'] for r in actual['sourceRows']]) and len(actual['positions']) == len(golden['positions'])
            and len(actual['sourceRows']) == golden['sourceRows']
            and [{k: row.get(k) for k in ('currency', 'amount')} for row in actual['cash']] == golden['cash']}


PROTOCOLS = {'apple-vision': 1, 'rapidocr': 2, 'local-codex': 3}


def check_engine(reply, engine, stage):
    """Both requests must be answered by the engine and review protocol that was asked for."""
    if reply.get('engine') != engine or reply.get('reviewProtocol') != PROTOCOLS[engine]:
        raise ValueError(f'{stage} reply came from engine {reply.get("engine")!r} protocol '
                         f'{reply.get("reviewProtocol")!r}, expected {engine!r} protocol {PROTOCOLS[engine]}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('fixture', 'live'), default='fixture')
    parser.add_argument('--raw', type=Path, help='raw OCR JSON, required in fixture mode')
    parser.add_argument('--image', type=Path, help='private PNG/JPEG, required in live mode')
    parser.add_argument('--golden', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='private report; do not commit real positions')
    parser.add_argument('--url', default='http://127.0.0.1:8798')
    parser.add_argument('--runs', type=int, default=1)
    parser.add_argument('--raw-output', type=Path, help='optional private raw evidence output')
    parser.add_argument('--engine', choices=tuple(PROTOCOLS), help='OCR engine; required in live mode, checked against fixtures')
    args = parser.parse_args()
    if not 1 <= args.runs <= 3:
        parser.error('--runs must be 1–3')
    url = urlsplit(args.url)
    if url.scheme != 'http' or url.hostname not in ('127.0.0.1', 'localhost', '::1'):
        parser.error('only local OCR preview URLs are allowed')
    golden = json.loads(args.golden.read_text())
    runs = []
    for _ in range(args.runs):
        try:
            if args.mode == 'fixture':
                if not args.raw:
                    parser.error('--raw is required in fixture mode')
                raw = json.loads(args.raw.read_text())
                if args.engine:
                    check_engine(raw, args.engine, 'fixture')
            else:
                if not args.image or not args.engine:
                    parser.error('--image and --engine are required in live mode')
                request = urllib.request.Request(args.url.rstrip('/') + '/api/recognize',
                    data=json.dumps({'image': base64.b64encode(args.image.read_bytes()).decode(), 'engine': args.engine}).encode(),
                    headers={'Content-Type': 'application/json', 'X-Portfolio-Preview': '1'})
                with urllib.request.urlopen(request, timeout=255 if args.engine == 'local-codex' else 120) as response:
                    raw = json.load(response)
                check_engine(raw, args.engine, 'initial')
                if args.raw_output:
                    args.raw_output.parent.mkdir(parents=True, exist_ok=True)
                    args.raw_output.write_text(json.dumps(raw))
                initial = normalize(raw)
                if args.engine == 'local-codex':
                    payload = {'image': base64.b64encode(args.image.read_bytes()).decode(), 'engine': args.engine,
                        'codexReview': {'firstRunId': raw['runId']}}
                    request = urllib.request.Request(args.url.rstrip('/') + '/api/recognize', data=json.dumps(payload).encode(),
                        headers={'Content-Type': 'application/json', 'X-Portfolio-Preview': '1'})
                    with urllib.request.urlopen(request, timeout=255) as response:
                        extra = json.load(response)
                    check_engine(extra,args.engine,'review')
                    if extra['sourceHash'] != raw['sourceHash'] or (extra['width'],extra['height']) != (raw['width'],raw['height']):
                        raise ValueError('Local crop response identity mismatch')
                    raw['localReviewReply'] = extra
                crops = initial['recognition'].get('quantityCrops', [])
                review_crops = initial['recognition'].get('reviewCrops', [])
                if crops or review_crops:
                    payload = {'image': base64.b64encode(args.image.read_bytes()).decode(), 'engine': args.engine}
                    if crops:
                        payload['quantityCrops'] = crops
                    if review_crops:
                        payload['reviewCrops'] = review_crops
                    request = urllib.request.Request(args.url.rstrip('/') + '/api/recognize', data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json', 'X-Portfolio-Preview': '1'})
                    with urllib.request.urlopen(request, timeout=255 if args.engine == 'local-codex' else 120) as response:
                        extra = json.load(response)
                    check_engine(extra, args.engine, 'review')
                    if extra['sourceHash'] != raw['sourceHash'] or (extra['width'],extra['height']) != (raw['width'],raw['height']):
                        raise ValueError('Local crop response identity mismatch')
                    raw['quantityRereads'] = extra.get('quantityRereads', [])
                    raw['reviewRereads'] = extra.get('reviewRereads', [])
            if args.raw_output:
                args.raw_output.parent.mkdir(parents=True, exist_ok=True)
                args.raw_output.write_text(json.dumps(raw))
            result = compare(normalize(raw), golden)
            result.update({'engine': raw.get('engine'), 'reviewProtocol': raw.get('reviewProtocol'), 'model': raw.get('model'), 'elapsedMs': raw.get('elapsedMs')})
        except ValueError as exc:
            result = {'allMatched': False, 'rejected': True, 'message': str(exc), 'differences': [], 'fields': {}}
        runs.append(result)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({'mode': args.mode, 'runs': runs}, ensure_ascii=False, indent=2))
    for index, run in enumerate(runs, 1):
        if run.get('rejected'):
            print(f"Run {index}: rejected; {run['message']}")
        else:
            known, unknown = run['nonNullFields'], run['unknownFields']
            print(f"Run {index}: {run['positionCount']['actual']}/{run['positionCount']['expected']} positions; "
                  f"{len(run['differences'])} field differences; non-null={known['correct']}/{known['total']}; "
                  f"unknown={unknown['correct']}/{unknown['total']}; allMatched={run['allMatched']}")
    # A nonzero exit is deliberate when the real OCR has errors; never turn it into a pass.
    return 0 if all(run['allMatched'] for run in runs) else 1


if __name__ == '__main__':
    raise SystemExit(main())
