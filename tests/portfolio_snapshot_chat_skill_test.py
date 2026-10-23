"""Synthetic contracts for the removable chat skill; no real images or inference."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from importlib.util import find_spec
if find_spec('PIL') is not None:
    from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'experimental_skills/tws-screenshot-json/scripts/portfolio_json.py'


def row(identity, kind='position', parent=None, **values):
    return {'rowId': identity, 'rowType': kind, 'parentRowId': parent,
            'description': 'synthetic ' + identity,
            'values': ({'instrument.symbol': 'XYZ', 'instrument.secType': 'FOP',
                        'instrument.expiryDate': '2030-10-18', 'instrument.right': 'P',
                        'instrument.strike': '100', 'quantity': '-2', **values}
                       if kind == 'position' else values), 'issues': []}


@unittest.skipUnless(find_spec('PIL'), 'Pillow is not installed in this Python')
class ChatSkillTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        self.image = self.folder / 'synthetic.png'
        image = Image.new('RGB', (180, 80))
        image.putdata([(x, y, (x+y) % 256) for y in range(80) for x in range(180)])
        image.save(self.image)

    def run_helper(self, *args, ok=True):
        result = subprocess.run([sys.executable, str(HELPER), *map(str, args)], capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, ok, result.stderr)
        return json.loads(result.stdout) if ok else result.stderr

    def build(self, rows, *, ok=True, extras=()):
        draft = self.folder / 'draft.json'
        draft.write_text(json.dumps({'headers': ['Instrument', 'POS'], 'notes': [], 'rows': rows}), encoding='utf8')
        output = self.folder / 'portfolio.json'
        result = self.run_helper('build', '--repo', ROOT, '--image', self.image,
                                 '--draft', draft, '--output', output, *extras, ok=ok)
        return (json.loads(output.read_text()), result) if ok else result

    def test_original_metadata_and_crop_pixels_and_no_overwrite(self):
        metadata = self.run_helper('inspect', '--image', self.image)
        self.assertEqual((metadata['width'], metadata['height']), (180, 80))
        target = self.folder / 'crop.png'
        self.run_helper('crop', '--image', self.image, '--rect', 10, 5, 21, 12, '--output', target)
        with Image.open(self.image) as source, Image.open(target) as crop:
            self.assertEqual(crop.size, (21, 12))
            self.assertEqual(crop.tobytes(), source.crop((10, 5, 31, 17)).tobytes())
        before = target.read_bytes()
        self.run_helper('crop', '--image', self.image, '--rect', 10, 5, 21, 12, '--output', target, ok=False)
        self.assertEqual(target.read_bytes(), before)
        self.run_helper('crop', '--image', self.image, '--rect', 170, 5, 21, 12, '--output', target, ok=False)

    def test_default_sibling_json_is_readable_and_never_overwrites(self):
        draft = self.folder / 'draft.json'
        draft.write_text(json.dumps({'headers':['Instrument','POS'], 'notes':['中文原文'], 'rows':[row('a')]}), encoding='utf8')
        self.run_helper('build', '--repo', ROOT, '--image', self.image, '--draft', draft)
        target = self.image.with_suffix('.json')
        text = target.read_text(encoding='utf8')
        self.assertIn('\n  "schemaVersion": 1,\n', text)
        self.assertIn('中文原文', text)
        self.assertEqual(json.loads(text)['positions'][0]['quantity'], '-2')
        self.run_helper('build', '--repo', ROOT, '--image', self.image, '--draft', draft, ok=False)
        self.assertEqual(target.read_text(encoding='utf8'), text)

    def test_complete_page_schema_zero_null_percent_cash_and_unknown_metadata(self):
        cash = row('c', 'cash'); cash.update(cashCurrency='USD', cashAmount='0')
        data, report = self.build([row('a', **{'displayValues.mark':'0', 'displayValues.displayIv':'25%'}), cash])
        p = data['positions'][0]
        self.assertEqual(p['displayValues']['mark'], '0')
        self.assertEqual(p['displayValues']['displayIv'], '0.25')
        self.assertIsNone(p['displayValues']['avgPrice'])
        self.assertEqual(data['cash'][0]['amount'], '0')
        self.assertIsNone(data['account']['value']); self.assertIsNone(data['asOf']['date'])
        self.assertEqual(len(p['fieldEvidence']), 20)
        self.assertEqual(p['reviewStatus'], 'unreviewed')
        self.assertEqual(data['review']['status'], 'needs_review')
        self.assertIsNone(data['recognition']['model'])
        self.assertFalse(data['recognition']['imageInput']['originalDetailVerified'])
        self.assertFalse(report['visualAccuracyVerified'])

    def test_arbitrary_nested_three_leg_combo_not_an_extra_position(self):
        rows = [row('outer', 'combo_summary'), row('a', parent='outer'), row('inner', 'combo_summary', 'outer'),
                row('b', parent='inner'), row('c', parent='inner'), row('d', parent='inner'), row('peer')]
        data, _ = self.build(rows)
        self.assertEqual(len(data['positions']), 5)
        self.assertEqual(data['sourceRows'][0]['combo']['atomicLegRowIds'], ['a','b','c','d'])
        self.assertEqual(data['sourceRows'][2]['combo']['atomicLegRowIds'], ['b','c','d'])
        self.assertEqual(data['sourceRows'][2]['combo']['status'], 'expanded_visible')
        self.assertIsNone(data['sourceRows'][-1]['parentRowId'])

    def test_cross_scope_and_duplicate_rows_refuse_without_output(self):
        cases = [[row('g', 'combo_summary'), row('peer'), row('a', parent='g')], [row('a'), row('a')],
                 [row('a', parent='future'), row('future', 'combo_summary')]]
        for rows in cases:
            with self.subTest(rows=rows):
                self.build(rows, ok=False)
                self.assertFalse((self.folder / 'portfolio.json').exists())

    def test_first_read_and_conflicting_second_read_and_raw_typography_survive(self):
        a = row('a', **{'displayValues.avgPrice':'1.23⁴', 'displayValues.lastPrice':'c3.20'})
        a['interpretations'] = {'displayValues.avgPrice':{'value':'1.234','reason':'Visible smaller final decimal digit'}}
        a['rereads'] = {'instrument.strike':[{'raw':'101','reason':'Local inspection differs'}]}
        data, _ = self.build([a])
        p = data['positions'][0]
        self.assertEqual(p['instrument']['strike'], '100')
        self.assertTrue(p['fieldEvidence']['instrument.strike']['visualChecks'][0]['conflict'])
        self.assertEqual(p['displayValues']['avgPrice'], '1.234')
        self.assertEqual(p['fieldEvidence']['displayValues.avgPrice']['raw'], '1.23⁴')
        self.assertIsNone(p['fieldEvidence']['displayValues.avgPrice']['originalValue'])
        self.assertEqual(p['fieldEvidence']['displayValues.lastPrice']['raw'], 'c3.20')
        self.assertIsNone(p['displayValues']['lastPrice'])
        self.assertTrue(p['issues'])

    def test_no_auto_unicode_normalization_and_no_qualifier_stripping(self):
        a = row('a', **{'displayValues.avgPrice':'1.23⁴'})
        data, _ = self.build([a]); self.assertIsNone(data['positions'][0]['displayValues']['avgPrice'])
        (self.folder / 'portfolio.json').unlink()
        a['values']['displayValues.lastPrice'] = 'c3.20'
        a['interpretations'] = {'displayValues.lastPrice':{'value':'3.20','reason':'remove qualifier'}}
        self.build([a], ok=False)

    def test_invalid_fields_and_guessed_missing_values_refuse(self):
        for field, value in [('quantity', 1), ('quantity', False), ('wrongField', '1')]:
            a = row('a'); a['values'][field] = value
            self.build([a], ok=False)
        a = row('a'); a['interpretations'] = {'displayValues.avgPrice':{'value':'1','reason':'invent absent value'}}
        self.build([a], ok=False)
        a = row('a'); a['cashAmount'] = '1'; self.build([a], ok=False)

    def test_unknown_identity_and_collapsed_combo_retained_and_manual_metadata(self):
        data, report = self.build([row('g','combo_summary'), row('a', **{'instrument.symbol':None})],
                                  extras=('--account','U123456','--asof','2030-01-02'))
        self.assertEqual(len(data['positions']), 0)
        self.assertEqual(data['sourceRows'][1]['rowType'], 'unclassified')
        self.assertEqual(data['sourceRows'][0]['combo']['status'], 'collapsed')
        self.assertEqual(data['account']['value'], 'U123456')
        self.assertEqual(data['asOf']['date'], '2030-01-02')
        self.assertEqual(report['unclassified'], 1)
        self.assertEqual(report['pendingStructure'], 2)


if __name__ == '__main__':
    unittest.main()
