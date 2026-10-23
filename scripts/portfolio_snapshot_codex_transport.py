"""Private stdio app-server connection for image-only Codex extraction.

The caller owns an isolated CODEX_HOME and read-only work directory. No RPC or
stderr transcript is persisted: input may contain a private screenshot.
"""
from __future__ import annotations

import json
import base64
import hashlib
import os
from pathlib import Path
import queue
import signal
import subprocess
import tempfile
import threading
import time


class TransportError(ValueError):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


def stop(process):
    if process.poll() is None:
        if os.name == 'posix':
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            process.kill()
    process.wait()


class Connection:
    def __init__(self, command, env, cwd, timeout=240):
        self.deadline = time.monotonic() + timeout
        self.events = queue.Queue()
        self.errors = tempfile.TemporaryFile()
        try:
            self.process = subprocess.Popen(command, env=env, cwd=cwd, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=self.errors, text=True, encoding='utf-8',
                start_new_session=os.name == 'posix')
        except OSError as e:
            self.errors.close()
            raise TransportError('codex_unavailable', '无法启动本机 Codex，当前表格已保留。') from e
        self.sequence = 0
        self.thread_id = self.turn_id = None
        self.final_text = None
        self.image_url = self.prompt = self.detail = None
        self.expected_content = None
        self.image_verified = False
        self.observed_turn_ids = set()
        self.byte_count = 0
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        try:
            for line in self.process.stdout:
                self.byte_count += len(line.encode('utf-8'))
                if self.byte_count > 16 * 1024 * 1024 or len(line) > 8 * 1024 * 1024:
                    self.events.put(TransportError('codex_output_invalid', 'Codex 回复过大，未采用。'))
                    return
                try:
                    def unique(pairs):
                        d = {}
                        for key, value in pairs:
                            if key in d:
                                raise ValueError('duplicate key')
                            d[key] = value
                        return d
                    message = json.loads(line, object_pairs_hook=unique)
                except (ValueError, TypeError):
                    self.events.put(TransportError('codex_output_invalid', 'Codex 通信格式无效，未采用。'))
                    return
                self.events.put(message)
        finally:
            self.events.put(None)

    def send(self, message):
        try:
            self.process.stdin.write(json.dumps(message, ensure_ascii=False) + '\n')
            self.process.stdin.flush()
        except (OSError, ValueError) as e:
            raise TransportError('codex_failed', 'Codex 连接中断，当前表格已保留。') from e

    def receive(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TransportError('codex_timeout', 'Codex 读取超时，当前表格已保留；不会自动重试。')
        try:
            message = self.events.get(timeout=remaining)
        except queue.Empty as e:
            raise TransportError('codex_timeout', 'Codex 读取超时，当前表格已保留；不会自动重试。') from e
        if isinstance(message, Exception):
            raise message
        if message is None or not isinstance(message, dict):
            raise TransportError('codex_failed', 'Codex 未完成本次读取，当前表格已保留。')
        if 'method' in message:
            self._notification(message)
        return message

    def _notification(self, message):
        method, params = message['method'], message.get('params', {})
        if not isinstance(params, dict):
            raise TransportError('codex_output_invalid', 'Codex 通知格式无效，未采用。')
        # No tool, approval, token refresh or other server request is delegated
        # to the host. Never acknowledge an action and continue extraction.
        if 'id' in message:
            raise TransportError('codex_tools_used', 'Codex 请求了提取之外的操作，本次结果未采用。')
        if method in ('warning', 'error'):
            raise TransportError('codex_runtime_error', 'Codex 报告警告或运行异常，本次结果未采用。')
        if method in ('item/started', 'item/completed'):
            item = params.get('item', {})
            if item.get('type') not in ('userMessage', 'agentMessage', 'reasoning'):
                raise TransportError('codex_tools_used', 'Codex 调用了提取之外的工具，本次结果未采用。')
            if self.thread_id and params.get('threadId') != self.thread_id:
                raise TransportError('codex_output_invalid', 'Codex 回复会话不匹配，未采用。')
            if self.turn_id and params.get('turnId') != self.turn_id:
                raise TransportError('codex_output_invalid', 'Codex 回复轮次不匹配，未采用。')
            if not isinstance(params.get('turnId'), str):
                raise TransportError('codex_output_invalid', 'Codex 回复缺少轮次，未采用。')
            self.observed_turn_ids.add(params['turnId'])
            if method == 'item/completed' and item.get('type') == 'userMessage':
                content = item.get('content', [])
                expected = self.expected_content or [{'type': 'text', 'text': self.prompt},
                    {'type': 'image', 'url': self.image_url, 'detail': self.detail}]
                if not isinstance(content, list) or len(content) != len(expected) or any(
                        not isinstance(actual, dict) or any(actual.get(k) != v for k, v in wanted.items())
                        for actual, wanted in zip(content, expected)):
                    raise TransportError('codex_image_mismatch', 'Codex 接收的原图或图片设置不一致，未采用。')
                self.image_verified = True
            if method == 'item/completed' and item.get('type') == 'agentMessage':
                if item.get('phase') == 'final_answer':
                    if self.final_text is not None or not isinstance(item.get('text'), str) \
                            or len(item['text'].encode('utf-8')) > 4 * 1024 * 1024:
                        raise TransportError('codex_output_invalid', 'Codex 最终回复重复或无效，未采用。')
                    self.final_text = item['text']

    def call(self, method, params):
        self.sequence += 1
        request_id = self.sequence
        self.send({'id': request_id, 'method': method, 'params': params})
        while True:
            message = self.receive()
            if message.get('id') == request_id and 'method' not in message:
                if 'error' in message or not isinstance(message.get('result'), dict):
                    raise TransportError('codex_runtime_error', 'Codex 接口拒绝本次请求，未采用。')
                return message['result']
            if 'id' in message and 'method' not in message:
                raise TransportError('codex_output_invalid', 'Codex 回复请求不匹配，未采用。')

    def extract(self, model, prompt, image_url, schema, cwd, effort='high', detail='original', extra_inputs=None):
        self.call('initialize', {'clientInfo': {'name': 'portfolio_snapshot', 'version': '2'},
            'capabilities': {'experimentalApi': True}})
        self.send({'method': 'initialized', 'params': {}})
        account = self.call('account/read', {'refreshToken': False})
        if not isinstance(account.get('account'), dict) or account['account'].get('type') != 'chatgpt':
            raise TransportError('codex_unavailable', '本机 Codex 未使用 ChatGPT 登录，当前表格已保留。')
        started = self.call('thread/start', {'model': model, 'modelProvider': 'openai',
            'cwd': str(cwd), 'approvalPolicy': 'never', 'sandbox': 'read-only', 'ephemeral': True})
        if started.get('model') != model or started.get('modelProvider') != 'openai' \
                or started.get('reasoningEffort') != effort or started.get('instructionSources') != [] \
                or started.get('approvalPolicy') != 'never' \
                or started.get('sandbox', {}).get('type') != 'readOnly' \
                or not started.get('thread', {}).get('ephemeral') \
                or not isinstance(started.get('cwd'), str) \
                or Path(started['cwd']).resolve() != Path(cwd).resolve():
            raise TransportError('codex_configuration_mismatch', 'Codex 模型、推理强度或隔离设置不匹配，未采用。')
        self.thread_id = started['thread']['id']
        # A data URL avoids exec --image's implicit file resize. Its decoded
        # bytes are checked by the caller and by native wire-capture regressions.
        self.image_url, self.prompt, self.detail = image_url, prompt, detail
        self.expected_content = [{'type': 'text', 'text': prompt},
            {'type': 'image', 'url': image_url, 'detail': detail}] + (extra_inputs or [])
        turn = self.call('turn/start', {'threadId': self.thread_id, 'model': model,
            'effort': effort, 'cwd': str(cwd), 'approvalPolicy': 'never',
            'input': self.expected_content,
            'outputSchema': schema})
        self.turn_id = turn.get('turn', {}).get('id')
        if not self.turn_id or self.observed_turn_ids - {self.turn_id}:
            raise TransportError('codex_output_invalid', 'Codex 缺少识别轮次，未采用。')
        while True:
            message = self.receive()
            if message.get('method') == 'turn/completed':
                p = message.get('params', {}); result = p.get('turn', {})
                if p.get('threadId') != self.thread_id or result.get('id') != self.turn_id \
                        or result.get('status') != 'completed' or result.get('error') is not None \
                        or self.final_text is None or not self.image_verified:
                    raise TransportError('codex_failed', 'Codex 未正常完成本次读取，当前表格已保留。')
                payload = base64.b64decode(self.image_url.split(',', 1)[1], validate=True)
                settings = {'model': started['model'],
                    'reasoningEffort': started['reasoningEffort'], 'imageDetail': detail,
                    'imageSha256': hashlib.sha256(payload).hexdigest(), 'imageByteLength': len(payload),
                    'imageVerified': 'app-server-user-message'}
                if extra_inputs:
                    settings['additionalImages'] = []
                    for item in extra_inputs:
                        if item['type'] != 'image':
                            continue
                        b = base64.b64decode(item['url'].split(',', 1)[1], validate=True)
                        settings['additionalImages'].append({'sha256': hashlib.sha256(b).hexdigest(),
                            'byteLength': len(b), 'detail': item['detail']})
                return self.final_text, settings

    def close(self):
        try:
            stop(self.process)
            self.reader.join(timeout=1)
        finally:
            for stream in (self.process.stdin, self.process.stdout, self.errors):
                stream.close()
