"""A stand-in for Cloudroom's website API (rewrite/storage-move-design.md), for tests only.

Core saves through five calls under CLOUDROOM_API_URL: upload links, records, diagnostics, feedback and automations.
Uploads go to a fake file store on the same server, like R2's signed links. `down` makes every call fail, as in an
outage. Keys follow the website's, without the thread folder.
"""
import gzip
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
from urllib.parse import parse_qs, urlsplit


class FakeApi:
    def __init__(self, token, store):
        self.token, self.store, self.down = token, store, False
        self.files, self.diagnostics, self.reports, self.automations, self.calls = {}, [], [], [], []
        api = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def answer(self, status, body=b'', kind='application/json'):
                body = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Type', kind)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def body(self):
                return self.rfile.read(int(self.headers.get('Content-Length') or 0))

            def handle_any(self, method):
                url = urlsplit(self.path)
                api.calls.append((method, url.path))
                if api.down:
                    return self.answer(503, {'error': 'down for the test'})
                if url.path.startswith('/files/'):
                    key = url.path[len('/files/'):]
                    if method == 'PUT':
                        data = self.body()
                        if key in api.files and self.headers.get('If-None-Match') == '*':
                            return self.answer(412)
                        api.files[key] = data
                        return self.answer(200)
                    return self.answer(405)
                if self.headers.get('Authorization') != 'Bearer ' + api.token or self.headers.get('X-Cloudroom-Store') != api.store:
                    return self.answer(401, {'error': 'This Core is not signed in to Cloudroom.'})
                op = url.path.removeprefix('/api/core/')
                if method == 'GET' and op == 'records':
                    query = {k: v[0] for k, v in parse_qs(url.query).items()}
                    after, limit = int(query.get('after', 0)), int(query.get('limit', 1000))
                    records = [r for r in api.records(query['session']) if r['sequence'] > after]
                    return self.answer(200, {'records': records[:limit], 'more': len(records) > limit})
                payload = json.loads(self.body() or b'null')
                if op == 'uploads':
                    host = self.headers.get('Host')
                    links = [{'url': f"http://{host}/files/{api.store}/{c['session']}/{c['first']:020}-{c['last']:020}.jsonl.gz"} for c in payload['chunks']]
                    return self.answer(200, {'uploads': links})
                if op == 'diagnostics':
                    api.diagnostics.extend(payload)
                    return self.answer(200, {'saved': len(payload)})
                if op == 'report':
                    api.reports.append(payload)
                    return self.answer(200, {'sent': True})
                if op == 'automation':
                    api.automations.append(payload)
                    return self.answer(200, {'id': '00000000-0000-4000-8000-000000000000', 'ok': True})
                return self.answer(404, {'error': 'Not found.'})

            def do_GET(self):
                self.handle_any('GET')

            def do_POST(self):
                self.handle_any('POST')

            def do_PUT(self):
                self.handle_any('PUT')

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}/api/core'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def records(self, session):
        """A session's saved records, oldest first, each sequence once."""
        found = {}
        for key in sorted(k for k in self.files if k.startswith(f'{self.store}/{session}/')):
            for line in gzip.decompress(self.files[key]).decode().splitlines():
                record = json.loads(line)
                found.setdefault(record['sequence'], record)
        return [found[n] for n in sorted(found)]

    def seed(self, session, records):
        """Saved history Core didn't write itself, such as another sandbox's."""
        body = gzip.compress(''.join(json.dumps(r) + '\n' for r in records).encode())
        self.files[f"{self.store}/{session}/{records[0]['sequence']:020}-{records[-1]['sequence']:020}.jsonl.gz"] = body

    def env(self):
        return {'CLOUDROOM_API_URL': self.url, 'CLOUDROOM_STORE': self.store}

    def close(self):
        self.server.shutdown()
        self.server.server_close()
