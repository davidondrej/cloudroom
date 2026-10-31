"""Browser-facing preview regressions. Real HTTP/Unix sockets; no SSH or production access."""
import concurrent.futures
import contextlib
from http.server import BaseHTTPRequestHandler
import http.client
import importlib.util
import io
import json
from pathlib import Path
import os
import plistlib
import socket
import socketserver
import shutil
import sys
import tarfile
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock
import uuid

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


if hasattr(socketserver, 'ThreadingUnixStreamServer'):  # Windows' Python has no Unix sockets.
    class UnixServer(socketserver.ThreadingUnixStreamServer):
        daemon_threads = True


@unittest.skipIf(sys.platform == 'win32', 'Unix sockets')
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


class Json(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.dumps({'echo': json.loads(self.rfile.read(int(self.headers['Content-Length'])))}).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)


class ControlTests(unittest.TestCase):
    def test_control_requests_reach_the_website_and_core(self):
        # Every website and core call goes through control(); nothing else in the helper may take its name.
        server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Json)
        threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        url = f'http://127.0.0.1:{server.server_address[1]}/api/desktop/sandboxes'
        self.assertEqual(preview.control(url, {'action': 'awake'}, 'POST', {}), {'echo': {'action': 'awake'}})


class UpstreamTimeoutTests(unittest.TestCase):
    @unittest.skipIf(sys.platform == 'win32', 'Unix sockets')
    def test_connect_to_a_full_socket_times_out(self):
        # The timeout must apply to connect() itself, or a stuck tunnel blocks a browser request forever.
        with tempfile.TemporaryDirectory(prefix='cr-preview-', dir='/tmp') as folder:
            path = Path(folder) / 'full.sock'
            listener = socket.socket(socket.AF_UNIX)
            listener.bind(str(path)); listener.listen(0)
            waiting = []
            try:
                while True:
                    client = socket.socket(socket.AF_UNIX); client.setblocking(False); waiting.append(client)
                    client.connect(str(path))
            except BlockingIOError:
                pass
            upstream = preview.Upstream(path)
            upstream.timeout = .3
            failures = []
            def connect():
                try:
                    upstream.connect()
                except OSError as error:
                    failures.append(error)
            attempt = threading.Thread(target=connect, daemon=True)
            attempt.start(); attempt.join(3)
            self.assertFalse(attempt.is_alive(), 'connect() ignored the timeout')
            self.assertEqual(len(failures), 1)
            for client in [*waiting, listener]:
                client.close()


@unittest.skipUnless(sys.platform == 'win32', 'Windows helper lifecycle')
class WindowsLifecycleTests(unittest.TestCase):
    def test_start_confirms_and_stop_asks_the_helper_to_exit(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            shutil.copyfile(spec.origin, folder / 'client.py')
            (folder / 'pid').write_text(str(os.getpid()))  # An old helper's pid file must never be used to stop anything.
            preview.windows(folder, False)
            self.assertTrue(preview.running(folder))
            self.assertTrue((folder / 'started').read_text())
            with self.assertRaises(OSError):  # A second start can't take the lock; it ends, and the running helper stays.
                preview.windows(folder, False)
            self.assertTrue(preview.running(folder))
            preview.windows(folder, True)
            self.assertFalse(preview.running(folder))
            preview.windows(folder, True)  # Stopping a stopped helper is a no-op.


class MacJobTests(unittest.TestCase):
    def test_job_core_gave_up_on_never_runs(self):
        # Feedback #247: a slow Mac ran a --write job after Core told the agent "Mac unavailable", so a retry ran it twice.
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            preview.save(folder / 'config.json', {'macAccess': 'full'})
            posted = []
            def fetch(url, body, *_):
                posted.append(body['state'])
                raise preview.ControlError(404)  # Core already dropped the unconfirmed job.
            core = SimpleNamespace(url='http://core', headers={}, connection={}, fetch=fetch, key='core')
            preview.MacJobs(folder).execute(core, 'mac', {'id': 'job', 'command': f'touch {folder}/ran', 'write': True})
            self.assertFalse((folder / 'ran').exists())
            self.assertEqual(posted, ['running'])

    def test_sandbox_with_a_key_list_gets_no_mac_jobs(self):
        # Security fix: a Cloud loop's run with only its picked keys (ADR 0342) could read any file on the Mac.
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            preview.save(folder / 'config.json', {'macAccess': 'full'})
            answers, asked, results = [], [], []
            def control(url, body, *_):
                asked.append((url, body))
                time.sleep(.05)
                answer = answers.pop(0)
                if isinstance(answer, Exception):
                    raise answer
                return answer
            def core(key, sandbox=True):
                return SimpleNamespace(url='http://core', headers={}, key=key, sandbox=sandbox, thread='thr_run',
                                       fetch=lambda url, body, *_: results.append(body) if body['state'] == 'done' else None,
                                       config={'connectionFile': str(folder / 'cloudroom.json')},
                                       connection={'account': {'id': '11111111-1111-4111-8111-111111111111'}, 'sandboxToken': 'a' * 64})
            jobs = preview.MacJobs(folder)
            def run(name, on):
                jobs.execute(on, 'mac', {'id': name, 'command': f'touch {folder}/{name}'})
                return results[-1]['code'], bytes.fromhex(results[-1]['stderr']).decode()
            run_sandbox, next_wake, vm = core('run'), core('next wake'), core('vm', sandbox=False)
            unconfirmed = "The Mac could not confirm this sandbox's API keys with Cloudroom, so the command did not run. Try again."
            with mock.patch.object(preview, 'control', control), mock.patch.object(preview, 'review', lambda *_: None):
                # Failed, from an older website, without a sandbox row, or garbled: each refuses and asks again next time.
                answers[:] = [preview.ControlError(503), {'secrets': None}, {'secrets': None, 'found': False}, {'secrets': '.env', 'found': True}]
                for name in ('failed', 'old', 'missing', 'garbled'):
                    self.assertEqual(run(name, run_sandbox), (126, unconfirmed))
                # Parallel first jobs ask once. Any list refuses, also one with .env, at every level and before any popup.
                answers[:] = [{'secrets': ['.env'], 'found': True}]
                with concurrent.futures.ThreadPoolExecutor(4) as pool:
                    refusals = set(pool.map(lambda _: jobs.limited(run_sandbox), range(4)))
                self.assertEqual(len(refusals), 1)
                self.assertIn('only the API keys picked for its Cloud loop', refusals.pop())
                self.assertEqual(run('limited', run_sandbox)[0], 126)
                for level, write in (('read-only', False), ('ask', True)):
                    preview.save(folder / 'config.json', {'macAccess': level})
                    self.assertEqual(jobs.refusal(run_sandbox, {'id': level, 'command': 'true', 'write': write}), jobs.limited(run_sandbox))
                preview.save(folder / 'config.json', {'macAccess': 'full'})
                # A sandbox the website found without a list, and the paired VM, run as before.
                answers[:] = [{'secrets': None, 'found': True}]
                self.assertEqual(run('allowed', next_wake)[0], 0)
                self.assertEqual(run('vm', vm)[0], 0)
            self.assertEqual([body for _, body in asked], [{'action': 'secrets', 'thread': 'thr_run'}] * 6)
            self.assertTrue(all(url == 'https://www.cloudroom.dev/api/desktop/sandboxes' for url, _ in asked))
            self.assertEqual(sorted(path.name for path in folder.iterdir() if path.suffix != '.json'), ['allowed', 'vm'])

    @unittest.skipIf(os.name == 'nt', 'Read-only needs the macOS sandbox')
    def test_read_only_hides_every_cloudroom_folder_with_keys(self):
        # Security fix: a Read-only command could read the relay key of the Mac this Mac runs threads for.
        with tempfile.TemporaryDirectory() as home:
            home = Path(home).resolve()
            data, machines, disk = home / 'data', home / '.bb-machines', home / 'disk'
            (machines / 'pro.cloudroom.run').mkdir(parents=True)
            (disk / 'air').mkdir(parents=True)
            (machines / 'air.cloudroom.run').symlink_to(disk / 'air')
            agents = home / 'Library' / 'LaunchAgents'
            agents.mkdir(parents=True)
            (agents / 'app.getbb.host-daemon.old.plist').write_bytes(
                plistlib.dumps({'EnvironmentVariables': {'BB_DATA_DIR': str(home / 'old-machine')}}))
            (agents / 'app.getbb.host-daemon.broken.plist').write_text('<?xml version="1.0"?><plist><dict>')
            with mock.patch.dict(os.environ, {'HOME': str(home)}):
                args = preview.read_only(data)
        params = dict(args[n + 1].split('=', 1) for n, arg in enumerate(args) if arg == '-D')
        group = lambda name: {Path(path) for key, path in params.items() if key.startswith(name)}
        self.assertEqual(group('FOLDER_'), {data, home / '.gui-cloudroom', home / '.gui-cloudroom-dev'})
        self.assertEqual(group('MACHINE_'), {machines, machines / 'pro.cloudroom.run', disk / 'air', home / 'old-machine'})
        profile = args[args.index('-p') + 1]
        self.assertTrue(all(f'(subpath (param "{key}"))' in profile for key in params if key.startswith(('FOLDER_', 'MACHINE_'))))
        # The tools exception reopens only this app's tools. Machine installs and old key copies come last, so neither the
        # tools nor the temp-folder write exception can reopen them, and they can't be rewritten either.
        order = [profile.index(rule) for rule in ('(deny file-read* (subpath (param "FOLDER_0"))', preview.READ_ONLY_TOOLS,
                                                    '(deny file-read* file-write* (subpath (param "MACHINE_0"))')]
        self.assertEqual(order, sorted(order))
        self.assertTrue(profile.endswith(f' {preview.READ_ONLY_OLD_KEYS})'))

    def test_ask_first_popup_shows_agent_text_as_text(self):
        # Security sweep: line breaks in a folder name could push the command out of view in the Ask first popup.
        shown = []
        class Popup:
            def __init__(self, args, **_):
                shown.append(args[3])
            def communicate(self):
                return 'Allow\n', None
        job = {'id': 'job', 'command': 'bash -s\necho two\N{RIGHT-TO-LEFT OVERRIDE}', 'cwd': '/tmp/a\nb' + 'c' * 300,
               'write': True, 'stdin': ''.join(f'echo {n}\r\n' for n in range(25)).encode().hex()}
        with mock.patch.object(preview.subprocess, 'Popen', Popup):
            self.assertTrue(preview.MacJobs(Path('/unused')).approve(SimpleNamespace(key='core'), job))
        lines = shown[0].split('\n')
        self.assertEqual(lines[2:12], ['Warning: 44 more characters of its input are not shown, and will also run.', '',
                                       'Command:', '    bash -s', '    echo two\\u202e', '',
                                       'Folder: /tmp/a\\nb' + 'c' * 191 + '…', '', 'Input (25 lines):', '    echo 0\\r'])
        self.assertEqual(lines[12:], [f'    echo {n}\\r' for n in range(1, 20)])
        self.assertTrue(all(c.isprintable() or c == '\n' for c in shown[0]))
        # Escapes count against the limit, and the hidden count stays in the agent's own characters.
        self.assertEqual(preview.visible('\0' * 300, 600, 10), ('\\x00' * 150, 150))

    @unittest.skipIf(sys.platform == 'win32', 'Mac access is macOS and Linux only')
    def test_push_places_only_its_named_item(self):
        # Security fix (#222): a push into a folder unpacked the sandbox's whole archive there, so it could add ~/.zshrc or a
        # LaunchAgent, or rewrite a file through a hard link. The Mac now builds the unpack and places only the named item.
        def archive(*entries):
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode='w:gz') as tar:
                for name, data, *extra in entries:  # data None is a folder; extra is a mode, or a link's (type, target).
                    info = tarfile.TarInfo(name)
                    if extra and isinstance(extra[0], int):
                        info.mode = extra[0]
                    elif extra:
                        info.type, info.linkname = extra[0]
                    elif data is None:
                        info.type, info.mode = tarfile.DIRTYPE, 0o755
                    info.size = len(data or b'')
                    tar.addfile(info, io.BytesIO(data or b''))
            return buffer.getvalue()
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(os.path.realpath(folder))
            home, outside = folder / 'home', folder / 'outside'
            (home / 'Library/LaunchAgents').mkdir(parents=True)
            (home / 'real').mkdir()
            (home / 'link').symlink_to(home / 'real')
            outside.mkdir()
            (outside / 'victim').write_text('victim')
            (home / 'v.txt').symlink_to(outside / 'victim')
            (home / '.zshrc').write_text('mine')
            preview.save(folder / 'config.json', {'macAccess': 'full'})
            results, jobs = [], preview.MacJobs(folder)
            core = SimpleNamespace(url='http://core', headers={}, key='vm', sandbox=False, connection={},
                                   config={'connectionFile': str(folder / 'cloudroom.json')},
                                   fetch=lambda url, body, *_: results.append(body) if body['state'] == 'done' else None)
            def push(data, name, to, staged=None):
                # The sandbox's own command, folder, and write flag never count.
                jobs.execute(core, 'mac', {'id': name, 'command': f'touch {folder}/ran', 'cwd': str(outside), 'write': False,
                                           'stdin': data.hex(), 'copy': {'name': name, 'to': to, 'staged': staged}})
                out = bytes.fromhex(results[-1]['stdout']).decode().strip()
                return results[-1]['code'], out.splitlines()[-1] if out else '', bytes.fromhex(results[-1]['stderr']).decode()
            with mock.patch.dict(os.environ, {'HOME': str(home)}), mock.patch.object(preview, 'review', lambda *_: None):
                # Other files, a hard link that carries data, and a file through a link: none of it lands.
                self.assertIn('held other files', push(archive(('notes.txt', b'mine'), ('.zshrc', b'x'), ('Library/LaunchAgents/x.plist', b'x')), 'notes.txt', '~')[2])
                self.assertNotEqual(push(archive(('notes', None), ('notes/h', b'x', (tarfile.LNKTYPE, '.zshrc'))), 'notes', '~')[0], 0)
                self.assertNotEqual(push(archive(('link', None, (tarfile.SYMTYPE, str(outside))), ('link/x', b'x')), 'link', '~')[0], 0)
                # Two items, one of them named like a line of the other's name, are two items.
                self.assertIn('held other files', push(archive(('a', b'x'), ('b', b'x')), 'a\nb', '~')[2])
                self.assertEqual(((home / '.zshrc').read_text(), sorted(path.name for path in outside.iterdir())), ('mine', ['victim']))
                self.assertFalse((folder / 'ran').exists() or (home / 'Library/LaunchAgents/x.plist').exists() or (home / 'notes.txt').exists())
                # Into the home folder, again (a file replaces), under a new name, and that name again.
                self.assertEqual(push(archive(('notes.txt', b'one')), 'notes.txt', '~')[:2], (0, f'{home}/notes.txt'))
                self.assertEqual(push(archive(('notes.txt', b'two')), 'notes.txt', '~')[:2], (0, f'{home}/notes.txt'))
                self.assertEqual(push(archive(('notes.txt', b'one')), 'notes.txt', '~/new.txt')[:2], (0, f'{home}/new.txt'))
                self.assertIn('already exists', push(archive(('notes.txt', b'two')), 'notes.txt', '~/new.txt')[2])
                self.assertEqual([(home / name).read_text() for name in ('notes.txt', 'new.txt')], ['two', 'one'])
                # A relative place starts at home, not the job's folder; a link in the place is resolved; and a link where the
                # item lands is replaced, never followed.
                self.assertEqual(push(archive(('r.txt', b'r')), 'r.txt', 'rel/')[:2], (0, f'{home}/rel/r.txt'))
                self.assertEqual(push(archive(('r.txt', b'r')), 'r.txt', '~/link')[:2], (0, f'{home}/real/r.txt'))
                self.assertEqual(push(archive(('v.txt', b'new')), 'v.txt', '~')[0], 0)
                self.assertEqual(((outside / 'victim').read_text(), (home / 'v.txt').is_symlink()), ('victim', False))
                # A folder merges, as cp does, also from a copy staged in pieces, whose staging is removed.
                (home / 'proj').mkdir()
                for name, text in (('keep', 'keep'), ('a', 'old')):
                    (home / 'proj' / name).write_text(text)
                staged = Path('/tmp/cloudroom.' + uuid.uuid4().hex)
                staged.mkdir()
                data = archive(('proj', None), ('proj/a', b'new'), ('proj/b', b'b'))
                (staged / '00000').write_bytes(data[:50])
                (staged / '00001').write_bytes(data[50:])
                self.assertEqual(push(b'', 'proj', '~/', str(staged))[:2], (0, f'{home}/proj'))
                self.assertEqual({path.name: path.read_text() for path in (home / 'proj').iterdir()}, {'a': 'new', 'b': 'b', 'keep': 'keep'})
                self.assertFalse(staged.exists())
                # A merge that can't pack every file fails and changes nothing (root can read any file).
                if os.geteuid():
                    self.assertNotEqual(push(archive(('proj', None), ('proj/a', b'newer'), ('proj/b', b'x', 0)), 'proj', '~')[0], 0)
                    self.assertEqual((home / 'proj/a').read_text(), 'new')
                # A name or place the Mac can't use is refused.
                for name, to in (('a/b', '~'), ('..', '~'), ('x', '~/missing/..'), ('x', '')):
                    self.assertEqual(push(b'', name, to)[0], 126)
                # A sandbox without Mac access gets the same answer whatever the place, so it can't probe for folders.
                with mock.patch.object(jobs, 'limited', lambda _: 'no access'):
                    self.assertEqual(jobs.refusal(core, {'copy': {'name': 'x', 'to': '~/missing/..'}}), 'no access')
            self.assertEqual((sorted(path.name for path in outside.iterdir()), list(home.rglob('.cloudroom.*'))), (['victim'], []))

    def test_ask_first_popup_shows_a_push_as_a_copy(self):
        # Security fix (#222): a push says where its one item really lands. Other commands warn about what they can't show.
        shown = []
        class Popup:
            def __init__(self, args, **_):
                shown.append(args[3])
            def communicate(self):
                return 'Allow\n', None
        with tempfile.TemporaryDirectory() as folder, mock.patch.dict(os.environ, {'HOME': folder}), \
                mock.patch.object(preview.subprocess, 'Popen', Popup):
            real, jobs, core = os.path.realpath(folder), preview.MacJobs(Path('/unused')), SimpleNamespace(key='core')
            copy = {'id': 'copy', 'command': 'touch ~/.zshrc', 'cwd': '/', 'stdin': '1f8b', 'copy': {'name': 'a\nb', 'to': '~'}}
            with mock.patch.object(preview, 'TEMP_FOLDERS', ()):  # On macOS this test's folder is a temp folder.
                self.assertIsNone(preview.as_copy(copy))
            self.assertEqual((copy['cwd'], copy['write'], copy['sandbox']), (None, True, False))
            self.assertTrue(copy['command'].startswith(f"b={real}; n='a\nb'; to='{real}/a\nb'; s=; "))
            self.assertTrue(jobs.approve(core, copy))
            self.assertTrue(jobs.approve(core, {'id': 'raw', 'command': 'cat /tmp/x/* | tar -xzf - -C ~', 'write': True, 'stdin': '1f8b00'}))
            with mock.patch.object(preview, 'TEMP_FOLDERS', (real,)):
                temp = {'copy': {'name': 'x', 'to': folder + '/'}}
                self.assertIsNone(preview.as_copy(temp))
                self.assertTrue(temp['write'] and temp['sandbox'])
            self.assertEqual(preview.as_copy({'copy': {'name': 'x', 'to': '~', 'staged': '/tmp/cloudroom.a/..'}}),
                             'This copy has a name or place the Mac cannot use, so nothing was copied.')
        self.assertEqual(shown[0], 'A cloud agent wants to copy a file or folder to your Mac.\n\nCopy to: ~/a\\nb\n\nOnly this one item is copied. '
                                   'It replaces a file with the same name there, and merges into a folder with the same name.')
        self.assertEqual(shown[1].split('\n\n')[1:3], ['Warning: the command uses files in a temp folder. Cloud agents can change those without asking, and they are not shown.',
                                                       'Warning: the command also reads 3 bytes of input that cannot be shown, such as an archive. What it changes can depend on that input.'])

if __name__ == '__main__':
    unittest.main()
