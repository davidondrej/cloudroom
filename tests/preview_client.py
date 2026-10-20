"""Browser-facing preview regressions. Real HTTP/Unix sockets; no SSH or production access."""
import concurrent.futures
import contextlib
import http.server
from http.server import BaseHTTPRequestHandler
import http.client
import importlib.util
from pathlib import Path
import socketserver
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
                 '/big': (200, b'"' + b'x' * (256 * 1024) + b'"'), '/bad': (200, b'{nope')}.get(self.path, (200, b'{"ok": true}'))
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


if __name__ == '__main__':
    unittest.main()
