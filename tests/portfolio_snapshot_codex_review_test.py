import base64
import hashlib
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch


def module(name, file):
    s = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / 'scripts' / file)
    m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m


R = module('codex_review', 'portfolio_snapshot_codex_review.py')
A = module('codex_adapter', 'portfolio_snapshot_codex.py')
SERVER = module('review_server', 'portfolio_snapshot_ocr_server.py')


def source():
    from PIL import Image, ImageDraw, ImageFont
    image = Image.new('RGB', (600, 240), '#191919'); d = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=20)
    for i, text in enumerate(('Instrument   Position   Mark', 'XZ FOP (Z8) Feb20 140 CALL   -3   0.25', 'LM Mar19 @TEST  1  123.45')):
        d.text((20, 25 + i * 55), text, fill='white', font=font)
    d.line((1, 0, 1, 240), fill='white'); d.line((0, 225, 600, 225), fill='white')
    b = io.BytesIO(); image.save(b, 'PNG'); return b.getvalue()


@unittest.skipUnless(importlib.util.find_spec('PIL'), 'Pillow is not installed in this Python')
class CropReview(unittest.TestCase):
    def test_light_theme_and_scaled_text_keep_distinct_measured_rows(self):
        from PIL import Image, ImageOps
        image=Image.open(io.BytesIO(source()))
        for candidate in (ImageOps.invert(image),image.resize((900,360),Image.Resampling.LANCZOS)):
            b=io.BytesIO();candidate.save(b,'PNG');manifest,_=R.crops(b.getvalue())
            self.assertEqual(len(manifest),3)
            self.assertTrue(all(a['rect'][1]+a['rect'][3]<=b['rect'][1]for a,b in zip(manifest,manifest[1:])))

    def test_measured_crops_keep_source_pixels_and_never_assign_columns(self):
        from PIL import Image
        image = source(); manifest, inputs = R.crops(image)
        self.assertEqual(len(manifest), 3)
        original = Image.open(io.BytesIO(image))
        for i, crop in enumerate(manifest):
            self.assertEqual(crop['cropId'], f'band-{i + 1}'); x, y, w, h = crop['rect']
            self.assertEqual(w, original.width); self.assertTrue(0 <= y < y + h <= original.height)
            data = base64.b64decode(inputs[i * 2 + 1]['url'].split(',', 1)[1])
            self.assertEqual(hashlib.sha256(data).hexdigest(), crop['sha256'])
            self.assertEqual(Image.open(io.BytesIO(data)).tobytes(), original.crop((x, y, x + w, y + h)).tobytes())
            self.assertNotIn('quantity', inputs[i * 2]['text'])

    def run_review(self, mutation=None):
        image = source(); manifest, _ = R.crops(image); calls = []
        def extract(*args, **kwargs):
            calls.append(kwargs)
            semantic = {'tableFound': True, 'headers': ['Instrument'], 'notes': [], 'rows': [
                {'cropId': c['cropId'], 'rowType': 'header' if i == 0 else 'position',
                 'description': 'synthetic', 'values': {k: None for k in R.FIELDS},
                 'cashCurrency': None, 'cashAmount': None, 'issues': []} for i, c in enumerate(manifest)]}
            settings = {'model': 'test', 'reasoningEffort': 'high', 'imageDetail': 'original',
                'imageVerified': 'app-server-user-message', 'imageSha256': hashlib.sha256(image).hexdigest(),
                'imageByteLength': len(image), 'additionalImages': [{k: c[k] for k in ('sha256','byteLength','detail')} for c in manifest]}
            if mutation: mutation(semantic, settings)
            return semantic, settings
        with patch.object(A,'cli_path',return_value='codex'), patch.object(A,'configured_model',return_value='test'), \
             patch.object(A,'model_catalog',return_value={}), patch.object(A,'run_extraction',side_effect=extract):
            result = R.recognize(image,'.png','first-pass',A)
        return result, calls

    def test_blind_review_has_its_own_prompt_schema_all_crops_and_input_echo(self):
        result, calls = self.run_review()
        self.assertEqual(len(calls),1); self.assertEqual(result['firstRunId'],'first-pass')
        self.assertEqual(result['phase'],'local-review'); self.assertEqual(result['reasoningEffort'],'high')
        self.assertEqual(len(calls[0]['extra_inputs']),6); self.assertNotEqual(calls[0]['prompt'],A.PROMPT)
        self.assertNotIn('first-pass',calls[0]['prompt']); self.assertNotIn('golden',calls[0]['prompt'])
        self.assertEqual(calls[0]['schema'],R.schema(A))

    def test_changed_effort_model_source_crop_proof_and_reply_order_are_refused(self):
        mutations = [lambda r,s:s.update(reasoningEffort='low'), lambda r,s:s.update(model='other'),
            lambda r,s:s.update(imageDetail='high'), lambda r,s:s.update(imageSha256='other'),
            lambda r,s:s.update(imageByteLength=1), lambda r,s:s.update(additionalImages=[]),
            lambda r,s:s['additionalImages'][0].update(sha256='other'), lambda r,s:r['rows'].reverse(),
            lambda r,s:r['rows'].pop(), lambda r,s:r['rows'][1].update(cropId=r['rows'][0]['cropId'])]
        for change in mutations:
            with self.assertRaises(A.CodexError): self.run_review(change)

    def test_input_limits_first_run_binding_and_missing_bands_fail_before_cloud(self):
        for image, binding in ((b'bad','first'),(source(),'bad binding')):
            with patch.object(A,'run_extraction') as run:
                with self.assertRaises(A.CodexError): R.recognize(image,'.png',binding,A)
                run.assert_not_called()
        with patch.object(R,'text_bands',return_value=[]),patch.object(A,'run_extraction') as run:
            with self.assertRaises(A.CodexError):R.recognize(source(),'.png','first',A)
            run.assert_not_called()

    def test_offline_engine_cannot_enter_cloud_review_route(self):
        with patch.object(SERVER,'codex_adapter') as adapter:
            for engine,request in (('rapidocr',{'firstRunId':'a'}),('local-codex',{}),('local-codex',{'firstRunId':'a','semantic':'not allowed'})):
                with self.assertRaises(SERVER.OcrError):SERVER.recognize_codex_review(source(),'.png',request,engine)
            adapter.assert_not_called()

    def test_http_review_route_binds_source_and_never_uses_the_first_pass_or_offline_crop_path(self):
        import json
        from email.message import Message
        image=source();body={'image':base64.b64encode(image).decode(),'engine':'local-codex','codexReview':{'firstRunId':'first'}}
        for mixed in (False,True):
            payload=dict(body)
            if mixed:payload['reviewCrops']=[]
            data=json.dumps(payload).encode();handler=object.__new__(SERVER.Handler)
            handler.path='/api/recognize';handler.headers=Message()
            handler.headers['Content-Type']='application/json';handler.headers['Content-Length']=str(len(data));handler.headers['X-Portfolio-Preview']='1'
            handler.rfile=io.BytesIO(data);handler.peer_allowed=lambda:True;answers=[];handler.respond=lambda status,reply:answers.append((status,reply))
            with patch.object(SERVER,'recognize_codex_review',return_value={'engine':'local-codex','reviewProtocol':3,'firstRunId':'first'}) as review,patch.object(SERVER,'recognize') as initial:
                handler.do_POST();initial.assert_not_called()
                if mixed:self.assertEqual(answers[0][0],422);review.assert_not_called()
                else:
                    review.assert_called_once_with(image,'.png',{'firstRunId':'first'},'local-codex')
                    self.assertEqual(answers[0][0],200);self.assertEqual(answers[0][1]['sourceHash'],hashlib.sha256(image).hexdigest())


if __name__ == '__main__': unittest.main()
