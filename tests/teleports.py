"""Teleport transfers over HTTP: ID ownership, workspace resolution, upload pinning, cancel and install."""
import hashlib
import http.client
import json
from pathlib import Path
import unittest

import core_fixture
from core_e2e import until


class TeleportTests(unittest.TestCase):
    setUp, tearDown, start = core_fixture.ReplayTests.setUp, core_fixture.ReplayTests.tearDown, core_fixture.ReplayTests.start

    def native(self, rid):
        return (json.dumps({'type': 'session_meta', 'payload': {'id': 'n' + rid}}) + '\n').encode()

    def manifest(self, rid, workspace='root', extra_files=()):
        native = self.native(rid)
        files = [{'path': 'rollout-x.jsonl', 'size': len(native), 'sha256': hashlib.sha256(native).hexdigest(),
                  'kind': 'native', 'origin': None}]
        files += list(extra_files)
        return {'request_id': rid, 'harness': 'codex', 'native_id': 'n' + rid, 'model': 'fixture', 'provider': None,
                'reasoning': None, 'service_tier': None, 'command_guard_enabled': None, 'workspace': workspace,
                'workspace_name': 'proj', 'files': files, 'handoff': 'continue', 'queued': []}

    def upload(self, rid, index, offset, digest, raw, size=None, expected=202):
        query = f'offset={offset}&sha256={digest}' + (f'&size={size}' if size is not None else '')
        connection = http.client.HTTPConnection(self.service.address, timeout=10)
        connection.request('POST', f'/v1/teleports/{rid}/files/{index}?{query}', raw,
                           {'Authorization': 'Bearer ' + self.env['CLOUDROOM_TOKEN'], 'Content-Type': 'application/octet-stream'})
        response = connection.getresponse()
        data = json.loads(response.read() or b'null')
        connection.close()
        self.assertEqual(response.status, expected, data)
        return data

    def test_refused_first_upload_does_not_pin_the_file_digest(self):
        self.start()
        project = {'path': 'notes.txt', 'size': 10, 'sha256': '', 'kind': 'project', 'origin': None}
        self.service.request('POST', '/v1/teleports', self.manifest('pin', extra_files=[project]), 202)
        digest = hashlib.sha256(b'0123456789').hexdigest()
        self.upload('pin', 1, 5, 'a' * 64, b'12345', expected=409)
        self.upload('pin', 1, 0, digest, b'0123456789')
        self.assertEqual(self.service.request('GET', '/v1/teleports/pin')['files'][1]['complete'], True)

    def test_upper_case_sha256_uploads_like_lower_case(self):
        self.start()
        body = b'0123456789'
        digest = hashlib.sha256(body).hexdigest()
        project = {'path': 'notes.txt', 'size': 10, 'sha256': digest.upper(), 'kind': 'project', 'origin': None}
        self.service.request('POST', '/v1/teleports', self.manifest('upper', extra_files=[project]), 202)
        self.upload('upper', 1, 0, digest.upper(), body)
        self.assertEqual(self.service.request('GET', '/v1/teleports/upper')['files'][1]['complete'], True)

    def test_a_transfer_saved_with_upper_case_digests_retries_and_uploads(self):
        self.start()
        body = b'0123456789'
        digest = hashlib.sha256(body).hexdigest()
        project = {'path': 'notes.txt', 'size': 10, 'sha256': digest, 'kind': 'project', 'origin': None}
        self.service.request('POST', '/v1/teleports', self.manifest('legacy', extra_files=[project]), 202)
        saved = self.state / 'teleports' / 'legacy' / 'manifest.json'
        data = json.loads(saved.read_text())
        for entry in data['manifest']['files']:
            entry['sha256'] = entry['sha256'].upper()
        saved.write_text(json.dumps(data))
        self.service.request('POST', '/v1/teleports', self.manifest('legacy', extra_files=[project]), 202)
        self.upload('legacy', 1, 0, digest, body)
        self.assertEqual(self.service.request('GET', '/v1/teleports/legacy')['files'][1]['complete'], True)

    def test_long_request_ids_prepare_and_activate(self):
        self.start()
        for rid in ('b' * 52, 'c' * 63):
            self.service.request('POST', '/v1/teleports', self.manifest(rid), 202)
            raw = self.native(rid)
            self.upload(rid, 0, 0, hashlib.sha256(raw).hexdigest(), raw)
            self.service.request('POST', f'/v1/teleports/{rid}/activate', {}, 202)

    def test_legacy_default_folder_prepares_and_retries_do_not_loop_on_503(self):
        self.start()
        view = self.service.request('POST', '/v1/teleports', self.manifest('legacy-ws', workspace='legacy'), 202)
        self.assertEqual(Path(view['workspace']).resolve(), self.repo.resolve())
        self.service.request('POST', '/v1/teleports', self.manifest('legacy-ws', workspace='legacy'), 202)

    def test_cancelled_teleport_removes_its_parts_and_refuses_reuse(self):
        self.start()
        body = b'0123456789'
        digest = hashlib.sha256(body).hexdigest()
        project = {'path': 'notes.txt', 'size': 10, 'sha256': digest, 'kind': 'project', 'origin': None}
        self.service.request('POST', '/v1/teleports', self.manifest('gone', extra_files=[project]), 202)
        self.upload('gone', 1, 0, digest, body[:5])
        self.service.request('POST', '/v1/teleports/gone/cancel', None, 202)
        self.assertEqual(list((self.state / 'teleports' / 'gone').glob('*.part')), [])
        self.assertEqual(self.service.request('GET', '/v1/teleports/gone')['phase'], 'cancelled')
        self.service.request('POST', '/v1/teleports', self.manifest('gone', extra_files=[project]), 409)

    def test_teleport_does_not_adopt_an_unrelated_session_with_its_id(self):
        self.start()
        self.service.request('POST', '/v1/sessions', {'request_id': 'teleport_abc'}, 202)
        until(lambda: self.service.session('cr_teleport_abc')['state'] == 'idle', 'ordinary session', 10)
        self.service.request('POST', '/v1/teleports', self.manifest('abc'), 409)
        self.assertNotIn('abc', self.service.session('cr_teleport_abc')['receipts'])
        self.assertEqual(self.service.session('cr_teleport_abc')['state'], 'idle')


if __name__ == '__main__': unittest.main()
