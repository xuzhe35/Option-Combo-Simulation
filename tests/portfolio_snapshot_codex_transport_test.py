import base64
import importlib.util
import json
from pathlib import Path
import queue
import shutil
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('transport', Path(__file__).resolve().parents[1] / 'scripts/portfolio_snapshot_codex_transport.py')
T = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(T)
URL = 'data:image/png;base64,' + base64.b64encode(b'synthetic-image').decode()


class Stream:
    def __init__(self): self.q = queue.Queue()
    def __iter__(self): return self
    def __next__(self):
        x = self.q.get()
        if x is None: raise StopIteration
        return x
    def close(self): self.q.put(None)


class Fake:
    def __init__(self, change=None, startup=None, **kwargs):
        self.stdout = Stream(); self.stdin = self; self.requests = []; self.returncode = None
        self.change, self.startup, self.stopped = change, startup or {}, False
    def poll(self): return self.returncode
    def wait(self): return self.returncode
    def halt(self): self.stopped = True; self.returncode = 0; self.stdout.q.put(None)
    def close(self): pass
    def flush(self): pass
    def push(self, x): self.stdout.q.put(json.dumps(x) + '\n')
    def write(self, line):
        request = json.loads(line); self.requests.append(request)
        method, n = request['method'], request.get('id')
        if method == 'initialize': self.push({'id': n, 'result': {}})
        elif method == 'account/read': self.push({'id': n, 'result': {'account': {'type': 'chatgpt'}}})
        elif method == 'thread/start':
            result = {'model': 'test-model', 'modelProvider': 'openai', 'reasoningEffort': 'high',
                'cwd': '/tmp/work', 'instructionSources': [], 'approvalPolicy': 'never',
                'sandbox': {'type': 'readOnly'}, 'thread': {'id': 't', 'ephemeral': True}}
            result.update(self.startup); self.push({'id': n, 'result': result})
        elif method == 'turn/start':
            image = {'type': 'image', 'url': URL, 'detail': 'original'}
            messages = [
                {'method': 'item/completed', 'params': {'threadId': 't', 'turnId': 'u',
                    'item': {'type': 'userMessage', 'content': [{'type': 'text', 'text': 'prompt'}, image]}}},
                {'id': n, 'result': {'turn': {'id': 'u', 'status': 'inProgress'}}},
                {'method': 'item/completed', 'params': {'threadId': 't', 'turnId': 'u',
                    'item': {'type': 'agentMessage', 'phase': 'final_answer', 'text': '{"ok":true}'}}},
                {'method': 'turn/completed', 'params': {'threadId': 't',
                    'turn': {'id': 'u', 'status': 'completed', 'error': None}}}]
            if self.change: messages = self.change(messages)
            for x in messages: self.push(x)


class Protocol(unittest.TestCase):
    def extract(self, fake, extra_inputs=None):
        with patch.object(T.subprocess, 'Popen', return_value=fake), patch.object(T, 'stop', side_effect=lambda p: p.halt()):
            c = T.Connection(['codex', 'app-server'], {}, '/tmp/work', timeout=.1)
            try: return c.extract('test-model', 'prompt', URL, {}, '/tmp/work', extra_inputs=extra_inputs)
            finally: c.close()

    def test_exact_model_high_and_original_echo_are_required(self):
        fake = Fake(); text, settings = self.extract(fake)
        self.assertEqual(text, '{"ok":true}'); self.assertEqual(settings['reasoningEffort'], 'high')
        self.assertEqual(settings['imageDetail'], 'original'); self.assertEqual(settings['imageByteLength'], 15)
        turn = next(x for x in fake.requests if x['method'] == 'turn/start')['params']
        self.assertEqual(turn['effort'], 'high'); self.assertEqual(turn['input'][1]['detail'], 'original')
        self.assertEqual(turn['input'][1]['url'], URL); self.assertTrue(fake.stopped)

    def test_configuration_changes_refuse_before_sending_image(self):
        for patching in ({'model': 'other'}, {'modelProvider': 'other'}, {'reasoningEffort': 'low'},
            {'instructionSources': ['/unwanted/AGENTS.md']}, {'sandbox': {'type': 'workspaceWrite'}},
            {'approvalPolicy': 'on-request'}, {'thread': {'id': 't', 'ephemeral': False}}):
            fake = Fake(startup=patching)
            with self.assertRaises(T.TransportError): self.extract(fake)
            self.assertFalse(any(x['method'] == 'turn/start' for x in fake.requests))
            self.assertTrue(fake.stopped)

    def test_every_additional_crop_echo_is_verified_without_accepting_changed_or_missing_pixels(self):
        extras=[{'type':'text','text':'LOCAL CROP band-1'}, {'type':'image','url':URL,'detail':'original'}]
        def complete(ms):ms[0]['params']['item']['content'].extend(extras);return ms
        fake=Fake(change=complete);_,settings=self.extract(fake,extras)
        self.assertEqual(settings['additionalImages'][0]['byteLength'],15)
        self.assertEqual(settings['additionalImages'][0]['detail'],'original')
        turn=next(r for r in fake.requests if r['method']=='turn/start')
        self.assertEqual(turn['params']['input'][2:],extras)
        for mode in ('missing','changed','detail'):
            def change(ms):
                import copy
                ms[0]['params']['item']['content'].extend(copy.deepcopy(extras))
                if mode=='missing':ms[0]['params']['item']['content'].pop()
                elif mode=='changed':ms[0]['params']['item']['content'][-1]['url']=URL+'x'
                else:ms[0]['params']['item']['content'][-1]['detail']='high'
                return ms
            with self.assertRaises(T.TransportError):self.extract(Fake(change=change),extras)

    def test_changed_missing_or_downgraded_image_cannot_be_adopted(self):
        for patching in ({'url': URL + 'x'}, {'detail': 'high'}, {'detail': None}, {'type': 'localImage'}):
            def change(messages):
                messages[0]['params']['item']['content'][1].update(patching); return messages
            fake = Fake(change=change)
            with self.assertRaises(T.TransportError): self.extract(fake)
            self.assertTrue(fake.stopped)

    def test_tools_warnings_and_host_requests_fail_without_acknowledging(self):
        failures = [
            {'method': 'warning', 'params': {'message': 'model metadata missing'}},
            {'method': 'error', 'params': {'willRetry': True}},
            {'id': 55, 'method': 'account/chatgptAuthTokens/refresh', 'params': {}},
            *[{'method': 'item/started', 'params': {'threadId': 't', 'turnId': 'u', 'item': {'type': kind}}}
              for kind in ('commandExecution', 'mcpToolCall', 'fileChange', 'webSearch', 'imageGeneration')]]
        for bad in failures:
            fake = Fake(change=lambda messages: [bad] + messages)
            with self.assertRaises(T.TransportError): self.extract(fake)
            self.assertFalse(any(x.get('id') == 55 and 'result' in x for x in fake.requests))
            self.assertTrue(fake.stopped)

    def test_wrong_turn_failed_or_missing_final_never_returns_success(self):
        def wrong_early_turn(ms): ms[0]['params']['turnId'] = 'other'; return ms
        def wrong_thread(ms): ms[2]['params']['threadId'] = 'other'; return ms
        def wrong_final_turn(ms): ms[2]['params']['turnId'] = 'other'; return ms
        def failed(ms): ms[-1]['params']['turn']['status'] = 'failed'; return ms
        def error(ms): ms[-1]['params']['turn']['error'] = {'message': 'error'}; return ms
        def missing_final(ms): return ms[:2] + ms[-1:]
        def duplicate_final(ms): return ms[:3] + ms[2:]
        for change in (wrong_early_turn, wrong_thread, wrong_final_turn, failed, error, missing_final, duplicate_final):
            fake = Fake(change=change)
            with self.assertRaises(T.TransportError): self.extract(fake)
            self.assertTrue(fake.stopped)

    def test_timeout_ends_one_run_without_retry(self):
        fake = Fake(change=lambda messages: messages[:2])
        with self.assertRaises(T.TransportError) as e: self.extract(fake)
        self.assertEqual(e.exception.code, 'codex_timeout')
        self.assertEqual(sum(x['method'] == 'turn/start' for x in fake.requests), 1)
        self.assertTrue(fake.stopped)

    @unittest.skipUnless(shutil.which('codex'), 'native Codex CLI not installed')
    def test_native_original_wire_preserves_large_image_bytes_and_high(self):
        import io
        from PIL import Image
        from tests.helpers.portfolio_snapshot_codex_wire import capture
        spec = importlib.util.spec_from_file_location('wire_adapter', Path(__file__).resolve().parents[1] / 'scripts/portfolio_snapshot_codex.py')
        adapter = importlib.util.module_from_spec(spec); spec.loader.exec_module(adapter)
        model = adapter.configured_model()
        if not model: self.skipTest('no configured model for native offline probe')
        catalog = adapter.model_catalog(shutil.which('codex'), model)
        buffer = io.BytesIO(); Image.new('RGB', (2512, 2336), '#426783').save(buffer, 'PNG')
        crop=io.BytesIO();Image.new('RGB',(1051,39),'#512987').save(crop,'PNG')
        result = capture(shutil.which('codex'), model, catalog, buffer.getvalue(),extra_images=[(crop.getvalue(),'image/png','LOCAL CROP band-1')])
        self.assertEqual(result['reasoningEffort'], 'high')
        self.assertEqual((result['images'][0]['width'], result['images'][0]['height']), (2512, 2336))
        self.assertEqual(result['images'][0]['byteLength'], len(buffer.getvalue()))
        self.assertEqual((result['images'][1]['width'], result['images'][1]['height']), (1051,39))
        self.assertEqual(result['images'][1]['byteLength'],len(crop.getvalue()))


if __name__ == '__main__': unittest.main()
