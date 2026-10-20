"""Browser-facing preview regressions. Real HTTP/Unix sockets; no SSH or production access."""
import concurrent.futures
import contextlib
import os
import http.server
from http.server import BaseHTTPRequestHandler
import http.client
import importlib.util
from pathlib import Path
import select
import socket
import socketserver
import subprocess
import ssl
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('preview', Path(__file__).parents[1] / 'src/preview/client.py')
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


class App(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def do_HEAD(self):
        if self.path == '/slow':
            time.sleep(3)
        self.send_response(405)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if self.path == '/events':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Connection', 'close')
            self.end_headers()
            for n in range(3):
                self.wfile.write(f'data: {n}\n\n'.encode()); self.wfile.flush(); time.sleep(.03)
        else:
            self.send_response(200)
            self.send_header('Content-Length', '2')
            self.end_headers(); self.wfile.write(b'ok')

    def do_POST(self):
        data = self.rfile.read(int(self.headers['Content-Length']))
        self.send_response(200)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers(); self.wfile.write(data)


class UnixServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='cr-preview-', dir='/tmp')
        self.addCleanup(self.directory.cleanup)
        sock = Path(self.directory.name) / 'upstream.sock'
        self.upstream = UnixServer(str(sock), App)
        self.tunnel = SimpleNamespace(socket_path=sock, generation='test-generation', closed=False,
            process=SimpleNamespace(poll=lambda: None), connections=set(), connections_lock=threading.Lock())
        self.server = preview.Server(('127.0.0.1', 0), preview.Proxy)
        self.server.authority = f'p3000-test.localhost:{self.server.server_port}'
        self.server.tunnel = self.tunnel
        self.tunnel.server = self.server
        for server in [self.upstream, self.server]:
            threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True).start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)

    def request(self, method='GET', path='/', headers=None, body=None):
        with contextlib.closing(http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)) as connection:
            connection.request(method, path, body=body, headers={'Host': self.server.authority, **(headers or {})})
            response = connection.getresponse()
            return response.status, response.getheaders(), response.read()

    def test_browser_path_streaming_upload_and_readiness(self):
        self.assertTrue(preview.Tunnel.healthy(self.tunnel))  # HEAD 405 still proves transport works.
        self.assertEqual(self.request()[2], b'ok')
        self.assertEqual(self.request('GET', '/events')[2], b'data: 0\n\ndata: 1\n\ndata: 2\n\n')
        body = b'x' * 131072
        self.assertEqual(self.request('POST', '/', body=body)[2], body)
        self.assertIn(('Content-Security-Policy', "frame-ancestors 'self'"), self.request()[1])

    def test_host_origin_and_websocket_requests_are_private(self):
        for headers in [
            {'Host': 'attacker.example'}, {'Origin': 'https://attacker.example'},
            {'Upgrade': 'websocket'},
            {'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe'},
        ]:
            self.assertEqual(self.request(headers=headers)[0], 403)
        self.assertEqual(self.request(headers={'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document'})[0], 200)
        self.assertEqual(self.request('POST', '/', headers={'Transfer-Encoding': 'chunked'})[0], 411)

    def test_healthy_upstream_does_not_hide_broken_local_proxy(self):
        with contextlib.closing(preview.Upstream(self.tunnel.socket_path)) as connection:
            connection.request('HEAD', '/')
            self.assertEqual(connection.getresponse().status, 405)
        self.server.RequestHandlerClass = App
        self.assertFalse(preview.Tunnel.healthy(self.tunnel))

    def test_slow_http_does_not_block_other_browser_requests(self):
        with concurrent.futures.ThreadPoolExecutor() as pool:
            slow = pool.submit(self.request, 'HEAD', '/slow')
            started = time.monotonic()
            self.assertEqual(self.request()[2], b'ok')
            self.assertLess(time.monotonic() - started, 2)
            self.assertEqual(slow.result()[0], 405)


class Control(BaseHTTPRequestHandler):
    """Records what the helper actually sends; synthetic tokens only."""
    protocol_version = 'HTTP/1.1'
    seen = []

    def log_message(self, *_):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        Control.seen.append((self.command, self.path, self.headers.get_all('User-Agent'), dict(self.headers), body))
        reply = {'/redirect': (302, b''), '/401': (401, b''), '/403': (403, b'error code: 1010'),
                 '/big': (200, b'"' + b'x' * (256 * 1024) + b'"'), '/bad': (200, b'{nope'), '/v1/mac/jobs?device=synthetic-device': (200, b': ping\n')}.get(self.path, (200, b'{"ok": true}'))
        self.send_response(reply[0])
        if reply[0] == 302:
            self.send_header('Location', 'https://elsewhere.invalid/steal')
        self.send_header('Content-Length', str(len(reply[1])))
        self.end_headers(); self.wfile.write(reply[1])
    do_GET = do_POST


class Remote:
    """A fake tunnel peer: records the handshake bytes and answers with a fixed status line."""
    def __init__(self, status):
        self.sent, self.status, self.closed = b'', status, False

    def sendall(self, data):
        self.sent += data

    def recv(self, _):
        reply, self.status = self.status, b''
        return reply

    def settimeout(self, _):
        pass

    def close(self):
        self.closed = True


class TransportTests(unittest.TestCase):
    def setUp(self):
        Control.seen = []
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Control)
        threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .01}, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.headers = {'Authorization': 'Bearer synthetic-token', 'X-Cloudroom-Token': 'synthetic-token'}

    def relay(self, *statuses, url='https://core.example.test', headers=None):
        relay = preview.Relay.__new__(preview.Relay)
        relay.core = SimpleNamespace(url=url, headers=headers or self.headers)
        relay.port, relay.device = 3000, 'synthetic-device'
        remotes = [Remote(status) for status in statuses]
        contexts, real = [], ssl.create_default_context
        def context():
            contexts.append(real())
            contexts[-1].wrap_socket = lambda sock, server_hostname: (contexts.append(server_hostname), sock)[1]
            return contexts[-1]
        with mock.patch.object(preview.socket, 'create_connection', side_effect=remotes) as dial, \
                mock.patch.object(preview.ssl, 'create_default_context', side_effect=context):
            try:
                result = relay.open()
            except OSError as error:
                result = error
        return result, remotes, contexts, dial

    def test_control_keeps_auth_method_body_and_refuses_redirects(self):
        self.assertEqual(preview.control(self.url + '/v1/previews/x', {'a': 1}, 'POST', self.headers), {'ok': True})
        method, path, _, sent, body = Control.seen[0]
        self.assertEqual((method, path, body), ('POST', '/v1/previews/x', b'{"a": 1}'))
        self.assertEqual((sent['Authorization'], sent['X-Cloudroom-Token'], sent['Content-Type']), ('Bearer synthetic-token', 'synthetic-token', 'application/json'))
        with self.assertRaisesRegex(ValueError, 'cannot redirect'):
            preview.control(self.url + '/redirect', None, 'GET', self.headers)
        self.assertEqual(len(Control.seen), 2)  # The redirect target is never contacted.

    def test_control_errors_stay_truthful_and_bounded(self):
        for path, code in [('/401', 401), ('/403', 403)]:
            with self.assertRaises(preview.ControlError) as caught:
                preview.control(self.url + path, None, 'GET', self.headers)
            self.assertEqual(caught.exception.code, code)
        with self.assertRaisesRegex(ValueError, 'too large'):
            preview.control(self.url + '/big', None, 'GET', self.headers)
        with self.assertRaises(ValueError):
            preview.control(self.url + '/bad', None, 'GET', self.headers)

    def test_control_and_tunnel_verify_tls(self):
        https = next(handler for handler in preview.OPENER.handlers if isinstance(handler, preview.urllib.request.HTTPSHandler))
        self.assertEqual((https._context.verify_mode, https._context.check_hostname), (ssl.CERT_REQUIRED, True))
        _, _, contexts, dial = self.relay(b'HTTP/1.1 101 Switching Protocols\r\n\r\n')
        self.assertEqual((contexts[0].verify_mode, contexts[0].check_hostname, contexts[1]), (ssl.CERT_REQUIRED, True, 'core.example.test'))
        self.assertEqual(dial.call_args.args[0], ('core.example.test', 443))

    def test_tunnel_falls_back_once_and_reports_refusal(self):
        (remote, rest), remotes, _, _ = self.relay(b'HTTP/1.1 400 Bad Request\r\n\r\n', b'HTTP/1.1 101 Switching Protocols\r\n\r\nearly')
        self.assertEqual((rest, remotes[0].closed), (b'early', True))
        self.assertEqual([r.sent.split(b'\r\n')[3] for r in remotes], [b'Upgrade: websocket', b'Upgrade: cloudroom-tunnel'])
        for status in [b'HTTP/1.1 401 Unauthorized\r\n\r\n', b'HTTP/1.1 403 Forbidden\r\n\r\n', b'garbage\r\n\r\n', b'']:
            error, remotes, _, _ = self.relay(status)
            self.assertIsInstance(error, OSError)
            self.assertNotIsInstance(error, PermissionError)
            self.assertEqual(len(remotes), 1)  # No retry beyond the one protocol fallback.

    def test_control_and_tunnel_identify_the_helper_the_same_way(self):
        # Proxies such as Cloudflare refuse urllib's default signature (#38); the helper names itself instead.
        preview.control(self.url + '/v1/previews/x', {}, 'POST', self.headers)
        self.assertEqual(Control.seen[0][2], ['Cloudroom-Helper'])
        _, remotes, _, _ = self.relay(b'HTTP/1.1 400 Bad Request\r\n\r\n', b'HTTP/1.1 101 Switching Protocols\r\n\r\n')
        for remote, protocol in zip(remotes, [b'websocket', b'cloudroom-tunnel']):
            lines = remote.sent.split(b'\r\n')
            self.assertEqual([line for line in lines if line.lower().startswith(b'user-agent:')], [b'User-Agent: Cloudroom-Helper'])
            self.assertEqual(lines[:4], [b'GET /v1/previews/3000/tunnel?device=synthetic-device HTTP/1.1', b'Host: core.example.test', b'Connection: Upgrade', b'Upgrade: ' + protocol])
            self.assertIn(b'Authorization: Bearer synthetic-token', lines)
            self.assertIn(b'X-Cloudroom-Token: synthetic-token', lines)
            self.assertTrue(remote.sent.endswith(b'\r\n\r\n'))
        # A caller's own User-Agent, in any casing, wins on both paths, as urllib already lets it, and is never sent twice.
        for name in ['User-Agent', 'user-agent', 'USER-AGENT']:
            Control.seen = []
            preview.control(self.url + '/v1/previews/x', {}, 'POST', {**self.headers, name: 'Caller'})
            self.assertEqual(Control.seen[0][2], ['Caller'])
            _, remotes, _, _ = self.relay(b'HTTP/1.1 101 Switching Protocols\r\n\r\n', headers={**self.headers, name: 'Caller'})
            self.assertEqual([line for line in remotes[0].sent.split(b'\r\n') if line.lower().startswith(b'user-agent:')], [name.encode() + b': Caller'])
        # Case variants of one name collapse as urllib collapses them: one header, the last value given, in either order.
        for first, last in [('User-Agent', 'user-agent'), ('user-agent', 'User-Agent')]:
            Control.seen = []
            preview.control(self.url + '/v1/previews/x', {}, 'POST', {**self.headers, first: 'First', last: 'Last'})
            self.assertEqual(Control.seen[0][2], ['Last'])
            _, remotes, _, _ = self.relay(b'HTTP/1.1 101 Switching Protocols\r\n\r\n', headers={**self.headers, first: 'First', last: 'Last'})
            self.assertEqual([line for line in remotes[0].sent.split(b'\r\n') if line.lower().startswith(b'user-agent:')], [last.encode() + b': Last'])

    def test_mac_jobs_stream_identifies_the_helper(self):
        folder = tempfile.TemporaryDirectory(prefix='cr-preview-', dir='/tmp')
        self.addCleanup(folder.cleanup)
        connection = Path(folder.name) / 'connection.json'
        preview.save(connection, {'url': self.url, 'token': 'synthetic-token'})
        core = preview.Core({'connectionFile': str(connection), 'binding': [self.url, None]})
        jobs = preview.MacJobs.__new__(preview.MacJobs)
        jobs.wanted = {core.key}
        jobs.enabled = lambda: jobs.wanted.clear()  # Stop after the first keepalive.
        with mock.patch.object(preview.time, 'sleep'):
            jobs.follow(core, 'synthetic-device')
        method, path, agents, sent, _ = Control.seen[0]
        self.assertEqual((method, path, agents, sent['Accept'], sent['Authorization']),
                         ('GET', '/v1/mac/jobs?device=synthetic-device', ['Cloudroom-Helper'], 'text/event-stream', 'Bearer synthetic-token'))


def certificates(folder):
    """A throwaway CA and a localhost server certificate, strict enough for Python's default X.509 checks."""
    run = lambda *args: subprocess.run(['openssl', *args], cwd=folder, check=True, capture_output=True)
    run('req', '-x509', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=Cloudroom test CA',
        '-keyout', 'ca.key', '-out', 'ca.pem', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign')
    run('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=localhost', '-keyout', 'edge.key', '-out', 'edge.csr')
    (Path(folder) / 'edge.ext').write_text('subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\n'
        'keyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nauthorityKeyIdentifier=keyid\nsubjectKeyIdentifier=hash\n')
    run('x509', '-req', '-in', 'edge.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-set_serial', '1', '-days', '1', '-extfile', 'edge.ext', '-out', 'edge.pem')


def read(sock):
    """One request head and its Content-Length body, so a refusal never closes on unread bytes (a TCP reset)."""
    data = b''
    while b'\r\n\r\n' not in data and (chunk := sock.recv(65536)):
        data += chunk
    lines = data.partition(b'\r\n\r\n')[0].split(b'\r\n')
    length = next((int(line.split(b':')[1]) for line in lines if line.lower().startswith(b'content-length:')), 0)
    while len(data.partition(b'\r\n\r\n')[2]) < length and (chunk := sock.recv(65536)):
        data += chunk
    return lines, data


class FakeCore(socketserver.BaseRequestHandler):
    """Plain loopback core behind the edge: checks the synthetic token, answers JSON, the jobs stream, and an echo tunnel."""
    def handle(self):
        lines, data = read(self.request)
        self.server.seen.append(lines)
        if b'Authorization: Bearer synthetic-token' not in lines:
            self.request.sendall(b'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return
        if b'/tunnel?' in lines[0] and self.server.legacy and b'Upgrade: websocket' in lines:
            self.request.sendall(b'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return
        if b'/tunnel?' in lines[0]:
            self.request.sendall(b'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
            while chunk := self.request.recv(65536):
                self.request.sendall(chunk)
            return
        self.server.bodies.append(data.partition(b'\r\n\r\n')[2])
        body = b': ping\n' if b'/v1/mac/jobs' in lines[0] else b'{"ok": true}'
        self.request.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: %d\r\nConnection: close\r\n\r\n' % len(body) + body)


class Edge(socketserver.BaseRequestHandler):
    """A TLS reverse proxy with the rule from #38: Cloudflare's Browser Integrity Check refuses urllib's signature."""
    def handle(self):
        with contextlib.suppress(OSError), self.server.tls.wrap_socket(self.request, server_side=True) as client:
            lines, data = read(client)
            self.server.seen.append(lines)
            if any(line.lower().startswith(b'user-agent: python-urllib') for line in lines):
                client.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 16\r\nConnection: close\r\n\r\nerror code: 1010'); return
            if lines[0].split(b' ')[1].startswith(b'/moved'):
                client.sendall(b'HTTP/1.1 302 Found\r\nLocation: https://elsewhere.invalid/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return
            with socket.create_connection(self.server.core, timeout=5) as core:
                core.sendall(data)
                while True:
                    ready = [client] if client.pending() else select.select([client, core], [], [], 5)[0]
                    if not ready:
                        return
                    for source in ready:
                        chunk = source.recv(65536)
                        if not chunk:
                            return
                        (core if source is client else client).sendall(chunk)


class ProxyIntegrationTests(unittest.TestCase):
    """The real helper through a local TLS edge proxy to a fake core. Verified TLS with a test CA; loopback only."""
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix='cr-preview-', dir='/tmp')
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)
        certificates(self.folder)
        servers = []
        for handler in [FakeCore, Edge]:
            server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), handler)
            server.daemon_threads, server.seen, server.bodies, server.legacy = True, [], [], False
            threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True).start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            servers.append(server)
        self.core, self.edge = servers
        self.edge.core = self.core.server_address
        self.edge.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.edge.tls.load_cert_chain(self.folder / 'edge.pem', self.folder / 'edge.key')
        self.url = f'https://localhost:{self.edge.server_address[1]}'

    def helper(self):
        """Load the shipped client afresh so its default TLS contexts trust only the test CA."""
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        connection = self.folder / 'connection.json'
        module.save(connection, {'url': self.url, 'token': 'synthetic-token'})
        return module, module.Core({'connectionFile': str(connection), 'binding': [self.url, None]})

    def test_helper_passes_the_edge_with_auth_tls_and_no_redirects(self):
        with mock.patch.dict(os.environ, {'SSL_CERT_FILE': str(self.folder / 'ca.pem')}):
            client, core = self.helper()
            self.assertEqual(core.request('/device', {'device': 'synthetic-device'}), {'ok': True})
            self.assertEqual(self.core.bodies, [b'{"device": "synthetic-device"}'])
            jobs = client.MacJobs.__new__(client.MacJobs)
            jobs.wanted = {core.key}
            jobs.enabled = lambda: jobs.wanted.clear()
            with mock.patch.object(client.time, 'sleep'):
                jobs.follow(core, 'synthetic-device')
            relay = client.Relay.__new__(client.Relay)
            relay.core, relay.port, relay.device = core, 3000, 'synthetic-device'
            remote, rest = relay.open()
            with remote:
                remote.sendall(b'raw bytes')
                self.assertEqual(rest + remote.recv(64), b'raw bytes')
            self.core.legacy = True  # A core before 0.1.35 knows only cloudroom-tunnel.
            remote, rest = relay.open()
            with remote:
                remote.sendall(b'old core')
                self.assertEqual(rest + remote.recv(64), b'old core')
            # Every request reached the core through the edge, authorized and named.
            for lines in self.core.seen:
                self.assertIn(b'Authorization: Bearer synthetic-token', lines)
                self.assertIn(b'X-Cloudroom-Token: synthetic-token', lines)
                self.assertEqual([line.split(b': ', 1)[1] for line in lines if line.lower().startswith(b'user-agent:')], [b'Cloudroom-Helper'])
            tunnel = [b'GET', b'/v1/previews/3000/tunnel?device=synthetic-device']
            self.assertEqual([lines[0].split(b' ')[:2] for lines in self.core.seen], [[b'POST', b'/v1/previews/device'],
                [b'GET', b'/v1/mac/jobs?device=synthetic-device'], tunnel, tunnel, tunnel])
            self.assertEqual([line for lines in self.core.seen[2:] for line in lines if line.startswith(b'Upgrade:')],
                             [b'Upgrade: websocket', b'Upgrade: websocket', b'Upgrade: cloudroom-tunnel'])
            self.assertIn(f'Host: localhost:{self.edge.server_address[1]}'.encode(), self.core.seen[2])
            # The edge still refuses urllib's signature, and a cross-origin redirect is never followed.
            with self.assertRaises(client.ControlError) as caught:
                client.control(self.url + '/v1/previews/x', None, 'GET', {**core.headers, 'User-Agent': 'Python-urllib/3.14'})
            self.assertEqual(caught.exception.code, 403)
            with self.assertRaisesRegex(ValueError, 'cannot redirect'):
                core.fetch(self.url + '/moved', None, 'GET', core.headers)
            self.assertEqual((len(self.edge.seen), len(self.core.seen)), (7, 5))
            self.assertEqual([lines[0].split(b' ')[1] for lines in self.edge.seen[5:]], [b'/v1/previews/x', b'/moved'])

    def test_helper_refuses_an_untrusted_edge(self):
        with mock.patch.dict(os.environ, {'SSL_CERT_FILE': str(self.folder / 'missing.pem')}):  # Trusts no test CA.
            client, core = self.helper()
            with self.assertRaises(OSError) as caught:
                core.request('/device', {'device': 'synthetic-device'})
            self.assertIsInstance(caught.exception.reason, ssl.SSLCertVerificationError)
            relay = client.Relay.__new__(client.Relay)
            relay.core, relay.port, relay.device = core, 3000, 'synthetic-device'
            with self.assertRaises(ssl.SSLCertVerificationError):
                relay.open()
        self.assertEqual(self.core.seen, [])


if __name__ == '__main__':
    unittest.main()
