import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

SPEC = importlib.util.spec_from_file_location('snapshot_codex', Path(__file__).resolve().parents[1] / 'scripts/portfolio_snapshot_codex.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
SERVER_SPEC = importlib.util.spec_from_file_location('snapshot_server_codex_tests', Path(__file__).resolve().parents[1] / 'scripts/portfolio_snapshot_ocr_server.py')
SERVER = importlib.util.module_from_spec(SERVER_SPEC)
SERVER_SPEC.loader.exec_module(SERVER)


def semantic():
    return {'tableFound': True, 'headers': ['Instrument', 'Qty'], 'notes': [], 'rows': [{
        'rowId': 'r1', 'rowType': 'position', 'parentRowId': None, 'description': 'XYZ synthetic',
        'partial': False, 'values': {key: None for key in M.FIELDS}, 'cashCurrency': None,
        'cashAmount': None, 'issues': []}]}


def png():
    from PIL import Image
    buffer = io.BytesIO()
    Image.new('RGB', (120, 80), 'white').save(buffer, format='PNG')
    return buffer.getvalue()


class CodexProtocol(unittest.TestCase):
    def test_schema_rejects_missing_extra_duplicate_and_numeric_values(self):
        self.assertEqual(M.parse_result(json.dumps(semantic())), semantic())
        bad = []
        x = semantic(); del x['headers']; bad.append(x)
        x = semantic(); x['account'] = 'U123456'; bad.append(x)
        x = semantic(); x['rows'][0]['values']['quantity'] = 1; bad.append(x)
        x = semantic(); x['rows'][0]['rowType'] = 'other'; bad.append(x)
        for value in bad:
            with self.assertRaises(M.CodexError): M.parse_result(json.dumps(value))
        for text in ('null', '[]', '{"tableFound":true,"tableFound":false}', 'not JSON'):
            with self.assertRaises(M.CodexError): M.parse_result(text)

    @unittest.skipUnless(importlib.util.find_spec('PIL'), 'Pillow is not installed in this Python')
    def test_status_needs_cli_and_chatgpt_login_without_api_key(self):
        with patch.object(M, 'cli_path', return_value=None): self.assertEqual(M.status(), 'cli_missing')
        with patch.object(M, 'cli_path', return_value='codex'), patch.object(M.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=b'Logged in using ChatGPT', stderr=b'')) as run:
            with patch.dict(M.os.environ, {'OPENAI_API_KEY': 'synthetic-not-a-secret'}), patch.object(M, 'auth_path', return_value=Path(__file__)):
                self.assertEqual(M.status(), 'ready'); self.assertNotIn('OPENAI_API_KEY', run.call_args.kwargs['env'])
        with patch.object(M, 'cli_path', return_value='codex'), patch.object(M.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stdout=b'', stderr=b'not logged in')):
            self.assertEqual(M.status(), 'login_required')

    @unittest.skipUnless(importlib.util.find_spec('PIL'), 'Pillow is not installed in this Python')
    def test_image_decode_and_limits_precede_any_model_call(self):
        from PIL import Image
        for image in (b'not a PNG', png()[:35]):
            with patch.object(M.subprocess, 'Popen') as process:
                with self.assertRaises(M.CodexError): M.recognize(image, '.png')
                process.assert_not_called()
        with patch.object(M, 'cli_path', return_value=None):
            with self.assertRaisesRegex(M.CodexError, '未找到'): M.recognize(png(), '.png')

    @unittest.skipUnless(importlib.util.find_spec('PIL'), 'Pillow is not installed in this Python')
    def test_isolated_original_data_url_and_explicit_high(self):
        captured = {}
        class Connection:
            def __init__(self, command, env, cwd, timeout):
                captured.update(command=command, env=env, cwd=cwd, timeout=timeout)
                home=Path(env['CODEX_HOME']); captured['config']=(home/'config.toml').read_text()
                captured['authReference']=(home/'auth.json').is_symlink()
            def extract(self, model, prompt, image_url, schema, cwd, effort, detail):
                import base64
                self.assertion = base64.b64decode(image_url.split(',',1)[1]) == png()
                assert self.assertion
                captured.update(model=model,prompt=prompt,schema=schema,effort=effort,detail=detail)
                return json.dumps(semantic()), {'model':model,'reasoningEffort':effort,'imageDetail':detail,'imageSha256':__import__('hashlib').sha256(png()).hexdigest(),'imageByteLength':len(png()),'imageVerified':'app-server-user-message'}
            def close(self): captured['closed']=True
        with tempfile.TemporaryDirectory() as folder:
            auth=Path(folder)/'login.json';auth.write_text('synthetic credential reference')
            transport=SimpleNamespace(Connection=Connection,TransportError=ValueError)
            with patch.object(M,'auth_path',return_value=auth),patch.object(M,'cli_path',return_value='codex'),patch.object(M,'configured_model',return_value='test-model'),patch.object(M,'model_catalog',return_value={'models':[]}),patch.object(M,'transport_module',return_value=transport):
                result=M.recognize(png(),'.png')
        self.assertEqual(result['engine'],'local-codex');self.assertEqual(result['reviewProtocol'],3)
        self.assertEqual(result['reasoningEffort'],'high');self.assertEqual(result['imageInput']['detail'],'original')
        self.assertEqual((result['imageInput']['width'],result['imageInput']['height']),(120,80))
        self.assertEqual(captured['effort'],'high');self.assertEqual(captured['detail'],'original')
        self.assertIn('model_reasoning_effort = "high"',captured['config'])
        self.assertEqual(captured['command'][1],'app-server');self.assertTrue(captured['authReference']);self.assertTrue(captured['closed'])
        self.assertNotIn('OPENAI_API_KEY',captured['env']);self.assertNotIn('OPENAI_BASE_URL',captured['env'])
        self.assertNotIn('Portfolio SC',captured['prompt']);self.assertNotIn('golden',captured['prompt'])
        self.assertFalse(Path(captured['cwd']).exists())

    def test_missing_model_catalog_capabilities_fail_closed(self):
        good={'models':[{'slug':'test-model','supports_image_detail_original':True,'supported_reasoning_levels':[{'effort':'high'}]}]}
        for change in ('missing_model','no_original','no_high'):
            data=copy.deepcopy(good)
            if change=='missing_model':data['models']=[]
            if change=='no_original':data['models'][0]['supports_image_detail_original']=False
            if change=='no_high':data['models'][0]['supported_reasoning_levels']=[]
            with patch.object(M.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps(data).encode())):
                with self.assertRaises(M.CodexError):M.model_catalog('codex','test-model')

    @unittest.skipUnless(importlib.util.find_spec('PIL'), 'Pillow is not installed in this Python')
    def test_transport_failure_closes_without_retry_and_invalid_output_refused(self):
        class TransportFailure(ValueError):
            code='codex_timeout';message='synthetic timeout'
        for text in (None,'{"tableFound":true,"tableFound":false}'):
            instances=[]
            class Connection:
                def __init__(self,*args):instances.append(self);self.closed=False
                def extract(self,*args):
                    if text is None:raise TransportFailure()
                    return text,{'model':'test-model','reasoningEffort':'high','imageDetail':'original'}
                def close(self):self.closed=True
            with tempfile.TemporaryDirectory() as folder:
                auth=Path(folder)/'auth';auth.write_text('synthetic')
                with patch.object(M,'auth_path',return_value=auth),patch.object(M,'cli_path',return_value='codex'),patch.object(M,'configured_model',return_value='test-model'),patch.object(M,'model_catalog',return_value={'models':[]}),patch.object(M,'transport_module',return_value=SimpleNamespace(Connection=Connection,TransportError=TransportFailure)):
                    with self.assertRaises(M.CodexError):M.recognize(png(),'.png')
            self.assertEqual(len(instances),1);self.assertTrue(instances[0].closed)

    def test_server_routes_codex_without_native_ocr_or_crops_and_never_cloud_falls_back(self):
        adapter=SimpleNamespace(recognize=lambda image,suffix: {'engine':'local-codex','reviewProtocol':3},CodexError=M.CodexError)
        with patch.object(SERVER,'codex_adapter',return_value=adapter),patch.object(SERVER,'recognize_rapidocr') as native:
            self.assertEqual(SERVER.recognize(b'image','.png',engine=SERVER.CODEX)['reviewProtocol'],3)
            native.assert_not_called()
            with self.assertRaises(SERVER.OcrError): SERVER.recognize(b'image','.png',crops=[],engine=SERVER.CODEX)
        with patch.object(SERVER,'engines',return_value={SERVER.VISION:False,SERVER.RAPIDOCR:False,SERVER.CODEX:True}):
            self.assertIsNone(SERVER.default_engine())
        self.assertIn('js/portfolio_snapshot_codex.js', SERVER.ASSETS)

if __name__ == '__main__': unittest.main()
