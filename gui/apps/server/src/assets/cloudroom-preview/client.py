#!/usr/bin/env python3
"""Independent localhost previews and Mac access. Standard-library control client; OpenSSH (VMs) or HTTPS tunnels (sandboxes)."""
import argparse
import base64
import concurrent.futures
import contextlib
import http.client
import hashlib
import http.server
import io
import ipaddress
import json
import os
from pathlib import Path
import plistlib
import random
import select
import shlex
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

WINDOWS = sys.platform == 'win32'
if WINDOWS:
    import msvcrt
else:
    import fcntl
    import pwd
# Windows files have no owner IDs or mode bits; the user's profile folder ACL keeps this folder private there.
NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)


def private_json(path):
    fd = os.open(path, os.O_RDONLY | NOFOLLOW)
    with os.fdopen(fd) as file:
        info = os.fstat(file.fileno())
        if not WINDOWS and (info.st_uid != os.getuid() or info.st_mode & 0o077):
            raise ValueError('Preview configuration must be private and owned by this user')
        return json.load(file)


def save(path, value):
    temporary = path.with_suffix('.pending')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as file:
        json.dump(value, file); file.flush(); os.fsync(file.fileno())
    temporary.replace(path)


def exclusive(file):
    """Locks `file` for this process, or raises BlockingIOError while another process holds it."""
    if not WINDOWS:
        return fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    file.seek(0)
    try:
        msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        raise BlockingIOError('Locked by another process') from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Preview control requests cannot redirect')


class ControlError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__('Preview control returned HTTP ' + str(code))


# HTTPS settings. urllib reads the macOS proxy setting only when these are built, so the helper rebuilds them while it
# can't connect: turning off a VPN or proxy then needs no restart (#109). Certificates come from the list shipped next to
# Cloudroom's Python (cacert.pem), else Python's own OpenSSL file, never the macOS Keychain.
NET = {}
NETWORK_SECONDS = 30
# Wakes job streams waiting to retry when the app asks to check again.
NUDGE = threading.Condition()
# Proxies such as Cloudflare refuse urllib's default User-Agent, so the helper names itself on every request.
USER_AGENT = 'Cloudroom-Helper'
# Mac commands' curl and git verify with the macOS trust store, which blocks leaked CA keys such as eMudhra's.
if sys.platform == 'darwin':
    os.environ.setdefault('CURL_SSL_BACKEND', 'secure-transport')


def tls():
    bundled = os.path.join(sys.prefix, 'cacert.pem')
    return ssl.create_default_context(cafile=bundled if os.path.isfile(bundled) and not os.environ.get('SSL_CERT_FILE') else None)


def network():
    context, proxies = tls(), urllib.request.getproxies()
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler(proxies), urllib.request.HTTPSHandler(context=context))
    opener.addheaders = [('User-Agent', USER_AGENT)]
    NET.update(opener=opener, proxies=proxies, cas=context.cert_store_stats()['x509_ca'], at=time.monotonic())


network()


def control(url, body, method, headers, timeout=5):
    request = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                     method=method, headers={**headers, 'Content-Type': 'application/json'})
    try:
        with NET['opener'].open(request, timeout=timeout) as response:
            raw = response.read(256 * 1024 + 1)
            if len(raw) > 256 * 1024:
                raise ValueError('Preview response is too large')
            return json.loads(raw)
    except urllib.error.HTTPError as error:
        error.close()
        raise ControlError(error.code) from None
    except http.client.HTTPException as error:  # A garbled or cut-off answer, such as from a proxy, is a network failure.
        raise urllib.error.URLError(error) from None


def website(config, connection):
    base = connection.get('websiteUrl', 'https://www.cloudroom.dev').rstrip('/')
    url = urllib.parse.urlsplit(base)
    if base not in ('https://www.cloudroom.dev', config.get('website')) and not (url.scheme == 'http' and url.hostname == '127.0.0.1' and url.port and not url.path and not url.query and not url.fragment and not url.username):
        raise ValueError('Invalid managed preview service')
    return base


class Core:
    """The paired VM's core, or, with `url` and `token`, one awake cloud sandbox's core."""
    def __init__(self, config, url=None, token=None, thread=None):
        connection = private_json(config['connectionFile'])
        self.config, self.connection = config, connection
        self.sandbox, self.thread = url is not None, thread
        self.url = (url or connection['url']).rstrip('/')
        parts = urllib.parse.urlsplit(self.url)
        if (parts.scheme != 'https' and not (parts.scheme == 'http' and parts.hostname in {'localhost', '127.0.0.1', '::1'})) or parts.username or parts.password or parts.query or parts.fragment:
            raise ValueError('Use an authenticated HTTPS core connection')
        if not self.sandbox and config['binding'] != [self.url, (connection.get('account') or {}).get('id')]:
            raise ValueError('Preview connection belongs to another account or VM')
        token = token if self.sandbox else connection.get('token', '')
        gate = None if self.sandbox else connection.get('gateToken')
        if not token or any(ord(c) < 33 or ord(c) > 126 for c in token):
            raise ValueError('Sign in to Cloudroom again')
        if gate is not None and (not gate or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~-' for c in gate)):
            raise ValueError('Invalid hosting credential')
        # Some sandbox proxies replace Authorization with their own login, so Core also reads X-Cloudroom-Token.
        self.headers = {'Authorization': 'Bearer ' + token, 'X-Cloudroom-Token': token, **({'Cookie': '_port_auth=' + gate} if gate else {})}
        # A sandbox gets a new token on every wake, so its tunnels and streams are rebuilt.
        self.key = (self.url, token)

    def prepare(self):
        account = (self.connection.get('account') or {}).get('id')
        if not account:
            return
        uuid.UUID(account)
        credential = base64.b64encode((account + ':' + self.connection['token']).encode()).decode()
        return self.fetch(website(self.config, self.connection) + '/api/desktop/previews', {}, None, {'Authorization': 'Basic ' + credential})

    def request(self, path, body=None, method=None):
        return self.fetch(self.url + '/v1/previews' + path, body, method, self.headers)

    def fetch(self, url, body, method, headers, timeout=5):
        return control(url, body, method, headers, timeout)


AWAKE = {'at': 0.0, 'checked': 0.0, 'key': None, 'list': [], 'blocked': 0, 'lock': threading.Lock()}
# Every Mac asks the website once a minute; the app touches this file after a wake, so new sandboxes show up at once.
AWAKE_SECONDS = 60
# Why the helper last failed to list or reach sandboxes. A VPN, proxy, antivirus, or firewall can block this helper while
# the app still works, so status.json says why instead of "connected" (#109).
PROBLEMS, ISSUERS = {}, {}
# Show only problems that outlast the next minute's check: by then a sandbox that fell asleep has left the list,
# and a short network drop has passed. Never ask the website more often (db-load-budget).
PROBLEM_SECONDS = AWAKE_SECONDS + 15
HERE = 'this PC' if WINDOWS else 'this Mac'


def cause(error):
    """The error underneath: urllib wraps socket and TLS errors."""
    reason = getattr(error, 'reason', None)
    return reason if isinstance(reason, BaseException) else error


def unsent(error):
    """True only when the request surely never reached our servers: a refused certificate, no DNS answer, or a refused
    connection or proxy tunnel. A timeout or reset may have reached them, so it is not one of these."""
    reason = cause(error)
    return isinstance(reason, (ssl.SSLCertVerificationError, socket.gaierror, ConnectionRefusedError)) or str(reason).startswith('Tunnel connection failed')


def describe(step, error, url):
    """A failed step, twice: the reason Settings shows under its own title (only what the user can act on, never our
    servers or internals), and the detail the app saves with the account for debugging (#109, ADR 0201)."""
    code, reason = getattr(error, 'code', None), cause(error)
    detail = f"{step} ({'website' if step == 'list' else 'sandbox'}): {type(error).__name__}"
    detail += f' > {type(reason).__name__}' if reason is not error else ''
    if code:
        message = 'Sign out of Cloudroom and sign in again.' if code == 401 else "Cloudroom didn't answer as expected. This is usually temporary."
        detail += f' HTTP {code}'
    elif isinstance(reason, ssl.SSLCertVerificationError):
        message = f'A VPN, proxy, or antivirus on {HERE} may be intercepting secure connections.'
        detail += f' {reason.verify_code} {reason.verify_message}' + (f'; {issuer(url)}' if step == 'list' else '')
    elif isinstance(reason, socket.gaierror):
        message = f"{HERE[0].upper() + HERE[1:]} can't look up Cloudroom. Check the internet connection or VPN."
        detail += ' ' + str(reason)[:100]
    elif unsent(error):
        message = f'A firewall, VPN, or proxy on {HERE} may be blocking Cloudroom.'
        detail += ' ' + str(reason)[:100]
    elif isinstance(reason, (OSError, http.client.HTTPException)):  # A drop, timeout, or garbled answer may be our side too.
        message = f"The connection to Cloudroom keeps failing. It may be {HERE}'s network, or a temporary problem."
        detail += ' ' + str(reason)[:100]
    else:
        message = "Cloudroom didn't answer as expected. This is usually temporary."
        detail += ' ' + str(reason)[:100]
    route = 'route unknown'
    with contextlib.suppress(OSError, ValueError):
        # urllib follows macOS's system proxy; the app's Node code does not, so a proxy can break only this helper.
        host = urllib.parse.urlsplit(url).hostname
        route = 'via system proxy' if NET['proxies'].get('https') and not urllib.request.proxy_bypass(host) else 'direct'
    return message, f"{detail[:220]}; {route}; Python {sys.version.split()[0]}, {ssl.OPENSSL_VERSION}, {NET['cas']} CAs"


def issuer(url):
    """Who signed the website's certificate as this Mac gets it directly, such as an antivirus's own root. Once per run."""
    parts = urllib.parse.urlsplit(url)
    key = (parts.hostname, parts.port or 443)
    if key not in ISSUERS:
        ISSUERS[key] = 'issuer unknown'
        with contextlib.suppress(OSError, ValueError, subprocess.SubprocessError):
            context = ssl.create_default_context()
            context.check_hostname, context.verify_mode = False, ssl.CERT_NONE  # Only to read who signed it, never to send data.
            with socket.create_connection(key, timeout=3) as raw, context.wrap_socket(raw, server_hostname=key[0]) as tls:
                der = tls.getpeercert(binary_form=True)
            out = subprocess.run(['openssl', 'x509', '-inform', 'DER', '-noout', '-issuer'], input=der, capture_output=True, timeout=3).stdout
            ISSUERS[key] = 'direct ' + out.decode(errors='replace').strip()[:90] if out.strip() else 'issuer unknown'
    return ISSUERS[key]


def cores(config):
    """The paired VM's core, if any, then every awake cloud sandbox's core (docs/scopes/sandboxes.md)."""
    connection = private_json(config['connectionFile'])
    found = [Core(config)] if connection.get('url') else []
    account, token = (connection.get('account') or {}).get('id'), connection.get('sandboxToken')
    if not account or not token:
        PROBLEMS.pop('sandboxes', None)
        return found
    woke = Path(config['connectionFile']).parent / 'cloudroom-preview' / 'woke'
    with AWAKE['lock']:
        nudged = False
        with contextlib.suppress(OSError):
            nudged = woke.stat().st_mtime > AWAKE['checked']
        due = AWAKE['key'] != (account, token) or nudged or time.monotonic() - AWAKE['at'] > AWAKE_SECONDS
        # While something fails, reread the proxy setting every 30 s and before each new list.
        if PROBLEMS and (due or time.monotonic() - NET['at'] >= NETWORK_SECONDS):
            network()
        if due:
            AWAKE.update(at=time.monotonic(), checked=time.time(), key=(account, token))
            try:
                uuid.UUID(account)
                credential = base64.b64encode((account + ':' + token).encode()).decode()
                listed = control(website(config, connection) + '/api/desktop/sandboxes', {'action': 'awake'}, 'POST', {'Authorization': 'Basic ' + credential})
                AWAKE['list'] = [(entry['origin'], entry['token'], entry.get('thread')) for entry in listed['sandboxes']]
                PROBLEMS.pop('sandboxes', None)
                AWAKE['blocked'] = 0
            except (OSError, ValueError, KeyError, TypeError) as error:
                # Keep the last list. A request that never reached our servers is retried in 10-20 s, at random so Macs
                # never line up after an outage; that costs our servers nothing (db-load-budget). Others wait a minute.
                AWAKE['blocked'] = AWAKE['blocked'] + 1 if unsent(error) else 0
                if AWAKE['blocked']:
                    AWAKE['at'] = time.monotonic() - AWAKE_SECONDS + random.uniform(10, 20)
                # Under the lock, so a status written meanwhile never misses it. A certificate failure first probes the
                # website, once per run.
                PROBLEMS['sandboxes'] = describe('list', error, connection.get('websiteUrl') or 'https://www.cloudroom.dev')
        awake = list(AWAKE['list'])
    if nudged:
        with NUDGE:
            NUDGE.notify_all()
    if config.get('ownThreads'):
        awake = own_threads(config, awake)
    for origin, secret, thread in awake:
        with contextlib.suppress(ValueError):
            found.append(Core(config, origin, secret, thread))
    return found


RELEASED = set()


def own_threads(config, awake):
    """Cloudroom Dev shares the real app's account, and a sandbox pairs only its first Mac helper. So Dev keeps the
    sandboxes of threads it woke (the app lists them in `own-threads`) and unpairs once from every other one."""
    owned = set()
    with contextlib.suppress(OSError):
        owned = set((Path(config['connectionFile']).parent / 'cloudroom-preview' / 'own-threads').read_text().split())
    for origin, secret, thread in awake:
        if thread not in owned and secret not in RELEASED:
            RELEASED.add(secret)
            with contextlib.suppress(OSError, ValueError):
                Core(config, origin, secret).request('/device/' + config['device'], method='DELETE')
    return [entry for entry in awake if entry[2] in owned]


class Upstream(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=10)
        self.path = path

    def connect(self):
        if WINDOWS:
            relay = RELAYS.get(self.path)
            if relay is None:
                raise ConnectionRefusedError('Preview tunnel closed')
            self.sock = relay.client()
            self.sock.settimeout(self.timeout)
        else:
            self.sock = socket.socket(socket.AF_UNIX)
            self.sock.settimeout(self.timeout)
            self.sock.connect(str(self.path))
        self.transport = self.sock


class UpgradeResponse(http.client.HTTPResponse):
    def __init__(self, sock, *args, **kwargs):
        super().__init__(sock, *args, **kwargs)
        self.fp.close()
        # Do not consume WebSocket frames while parsing the HTTP upgrade headers.
        self.fp = sock.makefile('rb', buffering=0)


HOP = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'}


class Proxy(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    rbufsize = 0

    def log_message(self, *_):
        pass

    def setup(self):
        super().setup()
        with self.server.tunnel.connections_lock:
            self.server.tunnel.connections.add(self.connection)

    def finish(self):
        with self.server.tunnel.connections_lock:
            self.server.tunnel.connections.discard(self.connection)
        super().finish()

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (OSError, ValueError, http.client.HTTPException):
            self.close_connection = True

    def forward(self):
        self.close_connection = True
        expected = self.server.authority
        origin = self.headers.get('Origin')
        if self.headers.get_all('Host') != [expected] or origin is not None and origin != 'http://' + expected:
            self.send_error(403, 'Preview origin is not allowed'); return
        if self.headers.get('Sec-Fetch-Site') == 'cross-site' and not (self.command in {'GET', 'HEAD'} and self.headers.get('Sec-Fetch-Mode') == 'navigate' and self.headers.get('Sec-Fetch-Dest') == 'document'):
            self.send_error(403, 'Cross-site preview request blocked'); return
        if not self.path.startswith('/') or self.path.startswith('//') or len(self.headers.get_all('Content-Length', [])) > 1:
            self.send_error(400, 'Invalid preview request'); return
        if self.headers.get('Transfer-Encoding'):
            self.send_error(411, 'Use a content length for preview uploads'); return
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            self.send_error(400, 'Invalid content length'); return
        if length < 0:
            self.send_error(400, 'Invalid content length'); return
        websocket = self.headers.get('Upgrade', '').lower() == 'websocket'
        if websocket and origin != 'http://' + expected:
            self.send_error(403, 'WebSocket origin is required'); return
        connection_headers = {v.strip().lower() for v in self.headers.get('Connection', '').split(',')}
        upstream = Upstream(self.server.tunnel.socket_path)
        if websocket:
            upstream.response_class = UpgradeResponse
        response = None
        sent_headers = False
        try:
            upstream.putrequest(self.command, self.path, skip_host=True, skip_accept_encoding=True)
            for key, value in self.headers.items():
                if key.lower() not in HOP | connection_headers:
                    upstream.putheader(key, value)
            upstream.putheader('Connection', 'Upgrade' if websocket else 'close')
            if websocket:
                upstream.putheader('Upgrade', 'websocket')
            upstream.endheaders()
            while length:
                data = self.rfile.read(min(length, 64 * 1024))
                if not data:
                    return
                upstream.send(data); length -= len(data)
            response = upstream.getresponse()
            upstream.transport.settimeout(None)
            self.send_response_only(response.status)
            excluded = HOP | {v.strip().lower() for v in response.getheader('Connection', '').split(',')}
            for key, value in response.getheaders():
                if key.lower() not in excluded | {'x-cloudroom-preview'}:
                    self.send_header(key, value)
            self.send_header('X-Cloudroom-Preview', self.server.tunnel.generation)
            self.send_header('Content-Security-Policy', "frame-ancestors 'self'")
            self.send_header('Connection', 'Upgrade' if response.status == 101 else 'close')
            if response.status == 101:
                self.send_header('Upgrade', 'websocket')
            self.end_headers()
            sent_headers = True
            if response.status == 101:
                if not websocket or upstream.sock is None:
                    return
                self.connection.settimeout(30); upstream.sock.settimeout(30)
                while not self.server.tunnel.closed:
                    readable, _, _ = select.select([self.connection, upstream.sock], [], [], 1)
                    for source in readable:
                        data = source.recv(64 * 1024)
                        if not data:
                            return
                        (upstream.sock if source is self.connection else self.connection).sendall(data)
            else:
                while data := response.read1(64 * 1024):
                    self.wfile.write(data); self.wfile.flush()
        except (OSError, ValueError, http.client.HTTPException):
            if not sent_headers and not self.wfile.closed:
                with contextlib.suppress(OSError):
                    self.send_error(502, 'Cloud preview unavailable; reconnecting')
        finally:
            if response is not None:
                response.close()
            upstream.close()

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = forward


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    # Windows lets a second program bind a port in use: always with SO_REUSEADDR, and on 127.0.0.1 over another program's
    # 0.0.0.0 or :: listener. Either would take over the user's own local server, so a port that answers counts as taken.
    allow_reuse_address = not WINDOWS

    def server_bind(self):
        if WINDOWS:
            port = self.server_address[1]
            with socket.socket() as probe:
                probe.settimeout(.5)
                if port and probe.connect_ex(('127.0.0.1', port)) == 0:
                    raise OSError(f'Port {port} is in use by another program')
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(15)
        return connection, address


# Windows' Python has no Unix sockets, so there each relay is found by its tunnel's socket path and hands out socket pairs.
RELAYS = {}


def reachable(path):
    """The tunnel's local end is there: its Unix socket, or on Windows its relay."""
    return path in RELAYS if WINDOWS else path.exists()


class Relay:
    """Sandbox previews (no SSH): each local connection becomes an HTTPS upgrade to the sandbox core, which
    joins it to the agent's port. It mimics the SSH process interface the tunnel code expects."""
    def __init__(self, core, port, device, path):
        self.core, self.port, self.device, self.stopped = core, port, device, False
        self.stderr = io.BytesIO()
        self.path, self.listener = path, None
        if WINDOWS:
            RELAYS[path] = self
            return
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(str(path)); os.chmod(path, 0o600); self.listener.listen(32)
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        while not self.stopped:
            try:
                client, _ = self.listener.accept()
            except OSError:
                return
            threading.Thread(target=self.pipe, args=(client,), daemon=True).start()

    def client(self):
        local, relayed = socket.socketpair()
        threading.Thread(target=self.pipe, args=(relayed,), daemon=True).start()
        return local

    def open(self):
        # Some sandbox proxies relay bytes only after a WebSocket handshake; cores before 0.1.35 know only cloudroom-tunnel.
        try:
            return self.connect('websocket')
        except PermissionError:
            return self.connect('cloudroom-tunnel')

    def connect(self, protocol):
        url = urllib.parse.urlsplit(self.core.url)
        remote = socket.create_connection((url.hostname, url.port or (443 if url.scheme == 'https' else 80)), timeout=10)
        if url.scheme == 'https':
            remote = tls().wrap_socket(remote, server_hostname=url.hostname)
        headers = ''.join(f'{key}: {value}\r\n' for key, value in {'User-Agent': USER_AGENT, **self.core.headers}.items())
        remote.sendall(f'GET /v1/previews/{self.port}/tunnel?device={self.device} HTTP/1.1\r\nHost: {url.netloc}\r\n'
                       f'Connection: Upgrade\r\nUpgrade: {protocol}\r\n{headers}\r\n'.encode())
        head = b''
        while b'\r\n\r\n' not in head:
            chunk = remote.recv(4096)
            if not chunk or len(head) > 16384:
                raise OSError('Preview tunnel closed')
            head += chunk
        status, rest = head.split(b'\r\n', 1)[0].split(), head.split(b'\r\n\r\n', 1)[1]
        if len(status) >= 2 and status[1] == b'400':
            remote.close()
            raise PermissionError('Preview tunnel protocol refused')
        if len(status) < 2 or status[1] != b'101':
            raise OSError('Preview tunnel refused')
        remote.settimeout(None)
        return remote, rest

    def pipe(self, client):
        try:
            remote, rest = self.open()
        except OSError:
            client.close(); return
        def copy(source, target):
            with contextlib.suppress(OSError):
                while data := source.recv(65536):
                    target.sendall(data)
            with contextlib.suppress(OSError):
                target.shutdown(socket.SHUT_WR)
        with contextlib.suppress(OSError):
            if rest:
                client.sendall(rest)
        back = threading.Thread(target=copy, args=(remote, client), daemon=True)
        back.start(); copy(client, remote); back.join()
        client.close(); remote.close()

    def poll(self):
        return 0 if self.stopped else None

    def terminate(self):
        self.stopped = True
        RELAYS.pop(self.path, None)
        with contextlib.suppress(OSError, AttributeError):
            self.listener.close()
    kill = terminate

    def wait(self, timeout=None):
        return 0


class Tunnel:
    def __init__(self, folder, core, port, generation, device, metadata, allow_private, local_port):
        self.closed = False
        self.connections = set()
        self.connections_lock = threading.Lock()
        self.endpoint, self.core = metadata, core
        self.port, self.generation = port, generation
        self.relay = bool(metadata.get('tunnel'))
        suffix = hashlib.sha256(core.url.encode()).hexdigest()[:8] if core.sandbox else ''
        self.socket_path = folder / f'p{port}{suffix}.sock'
        self.socket_path.unlink(missing_ok=True)
        self.log_path = folder / f'ssh-{port}{suffix}.log'
        self.stderr = bytearray()
        if self.relay:
            self.process = Relay(core, port, device, self.socket_path)
        else:
            self.process = self.ssh(folder, port, metadata, allow_private)
        self.listen(port, device, local_port)

    def ssh(self, folder, port, metadata, allow_private):
        if WINDOWS:
            raise OSError('SSH previews (VMs) need macOS or Linux')
        address = ipaddress.ip_address(metadata['host'])
        if not address.is_global and not allow_private:
            raise ValueError('Private SSH addresses require explicit self-hosted setup')
        if metadata.get('user') != 'cloudroom-preview' or type(metadata.get('port')) is not int or not 1 <= metadata['port'] <= 65535:
            raise ValueError('Invalid preview SSH endpoint')
        key = metadata.get('host_key', '')
        if len(key) != 80 or not key.startswith('ssh-ed25519 ') or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=' for c in key[12:]):
            raise ValueError('Invalid SSH host identity')
        known = folder / 'known_hosts'
        known.write_text('cloudroom-preview ' + key + '\n'); known.chmod(0o600)
        command = ['/usr/bin/ssh', '-F', '/dev/null', '-N', '-T', '-i', str(folder / 'id_ed25519'),
                   '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                   '-o', 'HostKeyAlias=cloudroom-preview', '-o', 'UserKnownHostsFile=' + str(known),
                   '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=5',
                   '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
                   '-L', f'{self.socket_path}:127.0.0.1:{port}', '-p', str(metadata['port']), f'cloudroom-preview@{address}']
        return subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    def listen(self, port, device, local_port):
        def capture():
            while data := self.process.stderr.read(1024):
                self.stderr.extend(data)
                del self.stderr[:-16384]
        self.capture = threading.Thread(target=capture, daemon=True)
        self.capture.start()
        try:
            try:
                self.server = Server(('127.0.0.1', local_port), Proxy)
            except OSError:
                self.server = Server(('127.0.0.1', 0), Proxy)
            self.server.authority = f'p{port}-{device[:8]}.localhost:{self.server.server_port}'
            self.server.tunnel = self
            self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .1}, daemon=True)
            self.thread.start()
        except BaseException:
            self.process.terminate(); self.process.wait(timeout=6)
            self.capture.join(timeout=1); self.process.stderr.close()
            raise

    def healthy(self):
        if self.process.poll() is not None or not reachable(self.socket_path):
            return False
        try:
            with contextlib.closing(http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)) as connection:
                connection.request('HEAD', '/', headers={'Host': self.server.authority})
                response = connection.getresponse()
                return response.getheader('X-Cloudroom-Preview') == self.generation
        except (OSError, http.client.HTTPException):
            return False

    def close(self):
        self.closed = True
        self.server.shutdown(); self.server.server_close()
        with self.connections_lock:
            for connection in self.connections:
                with contextlib.suppress(OSError):
                    connection.shutdown(socket.SHUT_RDWR)
        self.process.terminate()
        try:
            self.process.wait(timeout=6)
        except subprocess.TimeoutExpired:
            self.process.kill(); self.process.wait()
        self.capture.join(timeout=1); self.process.stderr.close()
        self.log_path.write_bytes(self.stderr); self.log_path.chmod(0o600)
        self.socket_path.unlink(missing_ok=True)


def identity(folder):
    key = folder / 'id_ed25519'
    public = folder / 'id_ed25519.pub'
    if not key.exists() and not public.exists():
        # Windows 10 and 11 include OpenSSH's ssh-keygen on PATH.
        subprocess.run(['ssh-keygen' if WINDOWS else '/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)], check=True, capture_output=True)
    info = key.lstat()
    if key.is_symlink() or not WINDOWS and (info.st_uid != os.getuid() or info.st_mode & 0o077) or public.is_symlink():
        raise ValueError('Unsafe preview SSH key')
    return ' '.join(public.read_text().split()[:2])


MAC_LIMIT = 16 * 1024 * 1024
MAC_LEVELS = ('off', 'read-only', 'ask', 'full')
# Read-only commands (ADR 0186): no file writes outside temp folders, no signals to other processes, and no tools that
# drive apps or system settings. Beyond those named tools, they cannot run programs from the writable temp folders, open
# apps or URLs through Launch Services, send Apple Events, create background jobs, or write preferences through cfprefsd.
# macOS also refuses setuid tools like ps and top here; pgrep and lsof still work.
# They also cannot reach this Mac's own servers and sockets (the app's local API, ssh-agent, Docker; DNS still works) or
# read Cloudroom's folder beyond its tools, so they cannot act through the app or its tokens (ADR 0260). The internet works.
READ_ONLY = ('(version 1)(allow default)(deny file-write*)'
             '(allow file-write* (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null") (literal "/dev/zero")'
             ' (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))'
             '(deny signal (target others))'
             '(deny process-exec (literal "/usr/bin/osascript") (literal "/usr/bin/open") (literal "/usr/bin/shortcuts")'
             ' (literal "/usr/bin/automator") (literal "/bin/launchctl") (literal "/usr/bin/tccutil") (literal "/usr/bin/defaults"))'
             '(deny process-exec (subpath "/private/tmp") (subpath "/private/var/folders"))'
             # System services act outside this sandbox, so block the routes rather than only the tools that use them.
             '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.coreservices.appleevents")'
             ' (global-name "com.apple.lsd.open") (global-name "com.apple.lsd.openurl") (global-name "com.apple.lsd.modifydb"))'
             '(deny appleevent-send)(deny job-creation)(deny user-preference-write)'
             # Seatbelt's localhost misses IPv4-mapped IPv6 like ::ffff:127.0.0.1, so IPv6 is blocked outright and clients fall
             # back to IPv4. It must be ip4 here: next to an ip6 rule, (remote ip "localhost:*") stops matching 127.0.0.1.
             '(deny network-outbound (remote ip4 "localhost:*") (remote ip6 "*:*") (remote unix-socket))'
             '(allow network-outbound (literal "/private/var/run/mDNSResponder"))'
             '(deny file-read* (subpath (param "DATA")))'
             '(allow file-read* (literal (param "DATA")) (subpath (param "DATA_BIN")) (subpath (param "DATA_HARNESS")))')


def read_only(data):
    """sandbox-exec arguments for a read-only command; `data` is Cloudroom's folder, which holds its tokens."""
    data = data.resolve()  # Seatbelt matches real paths.
    params = {'DATA': data, 'DATA_BIN': data / 'bin', 'DATA_HARNESS': data / 'browser-harness'}
    return ['/usr/bin/sandbox-exec', *(arg for key, path in params.items() for arg in ('-D', f'{key}={path}')), '-p', READ_ONLY]
ASK = '''on run argv
activate
display dialog (item 1 of argv) with title "Cloudroom" buttons {"Allow", "Allow for this sandbox", "Deny"} default button "Deny" cancel button "Deny" with icon caution giving up after 300
return button returned of result
end run'''


def visible(text, chars, lines):
    """The part of an agent's text the Ask first popup shows, and how many characters it leaves out. Characters the
    popup could hide or show as something else, like \\r or a right-to-left mark, show as escapes such as \\u202e.
    Only \\n breaks lines, and with `lines` at 1 it is escaped too."""
    shown, keep = [], '\n' if lines > 1 else ''
    for c in text:
        c = c if c.isprintable() or c in keep else c.encode('unicode_escape').decode()
        lines, chars = lines - (c == '\n'), chars - len(c)
        if chars < 0 or not lines:
            break
        shown.append(c)
    return ''.join(shown), len(text) - len(shown)


def block(text):
    """Agent text under its label in the Ask first popup: its lines are indented, and the popup's own lines are not."""
    return '    ' + text.replace('\n', '\n    ')


# Hex characters per result request: some sandbox proxies drop requests over about 8 MB,
# and each part must upload within MAC_POST_SECONDS on a slow home connection.
MAC_PART = 1024 * 1024
MAC_POST_SECONDS = 60
# New per helper process: when it changes, Core ends jobs the old process was running (#569).
MAC_BOOT = uuid.uuid4().hex


def mac_stdin(core, device, job):
    """A job's input, downloaded after confirming it, so a big push never holds up other jobs on the stream (#576).
    Older cores send it inside the job instead. None if it can't be downloaded."""
    size = job.get('stdin_bytes')
    if not size:
        return job.get('stdin') or ''
    url = core.url + '/v1/mac/jobs/' + urllib.parse.quote(job['id']) + '/stdin?device=' + urllib.parse.quote(device)
    for _ in range(3):
        try:
            with NET['opener'].open(urllib.request.Request(url, headers=core.headers), timeout=MAC_POST_SECONDS) as response:
                data = response.read(size + 1)
            if len(data) == size:
                return data.hex()
        except urllib.error.HTTPError as error:
            error.close()
            return None  # Core already gave up on this job.
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(1)
    return None


def mac_level(config):
    """Older setups stored on/off; on meant full access."""
    value = config.get('macAccess')
    return 'full' if value is True else value if value in MAC_LEVELS else 'off'


# Each Mac command also goes to the website's Jev check (ADR 0224). It runs beside the job and never delays it:
# at most four reports in flight, a repeated command is skipped for an hour, and failures are dropped.
REVIEWS = {'sent': {}, 'lock': threading.Lock(), 'slots': threading.BoundedSemaphore(4)}
SCRIPT_TYPES = ('.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl')


def script_of(job):
    """A script file the command runs, often one the agent just pushed to /tmp, so the check judges what really runs."""
    folder = Path.home() / os.path.expanduser(job.get('cwd') or '~')
    for word in job['command'].split():
        path = folder / os.path.expanduser(word.strip('\'"();&|'))
        if path.suffix in SCRIPT_TYPES and not str(path).startswith(('/Volumes/', '/Network/')) and path.is_file():
            with open(path, errors='replace') as file:
                return file.read(8000)
    return None


def review(core, job, level, script):
    account, token = (core.connection.get('account') or {}).get('id'), core.connection.get('sandboxToken')
    key, now = (core.url, job.get('command')), time.monotonic()
    with REVIEWS['lock']:
        sent = REVIEWS['sent']
        for old in [k for k, at in sent.items() if now - at > 3600]:
            del sent[old]
        if not account or not token or key in sent or not REVIEWS['slots'].acquire(blocking=False):
            return
        sent[key] = now

    def send():
        try:
            credential = base64.b64encode((account + ':' + token).encode()).decode()
            body = {'command': job['command'][:8000], 'cwd': job.get('cwd'), 'write': bool(job.get('write')), 'level': level, 'thread': core.thread}
            if script:
                with contextlib.suppress(OSError, ValueError):
                    body['script'] = script_of(job)
            control(website(core.config, core.connection) + '/api/desktop/mac-reviews', body, 'POST', {'Authorization': 'Basic ' + credential})
        except (OSError, ValueError, KeyError, TypeError):
            pass
        finally:
            REVIEWS['slots'].release()
    threading.Thread(target=send, daemon=True).start()


def deliver(post, result):
    """Large output travels in parts, then `done` carries the rest. A core without parts (HTTP 422) gets it whole."""
    if len(result['stdout']) + len(result['stderr']) > MAC_PART:
        try:
            for name in ('stdout', 'stderr'):
                for offset in range(0, len(result[name]), MAC_PART):
                    post({'state': 'part', 'offset': offset, name: result[name][offset:offset + MAC_PART]})
            result = {**result, 'stdout': '', 'stderr': ''}
        except ControlError as error:
            if error.code != 422:
                raise
    post(result)


class MacJobs:
    """Mac access (ADR 0113, levels in ADR 0186): run commands from the user's cloud agents as this user, only while enabled."""
    def __init__(self, folder):
        self.folder, self.running, self.lock = folder, {}, threading.Lock()
        # Jobs the agent stopped before they started; execute skips them.
        self.cancelled = set()
        # Ask first: one dialog at a time. "Allow for this sandbox" trusts every agent on that sandbox's core (jobs carry no
        # thread), until the helper restarts or the access level changes.
        self.asking, self.trusted, self.level = threading.Lock(), set(), None

    def enabled(self):
        config = private_json(self.folder / 'config.json')
        return config if mac_level(config) != 'off' and not config.get('revoked') else None

    def approve(self, core, job):
        with self.asking:
            if core.key in self.trusted:
                return True
            # Show what will run, including a script sent as input. Hidden parts still run: warn above them, where
            # padding cannot push the warning out of view. The command comes first, and the folder after it on one
            # line, so a folder name cannot pose as the command. Return always denies.
            command, hidden = visible(job['command'].rstrip(), 600, 10)
            warnings = f"Warning: {hidden:,} more characters of this command are not shown, and will also run.\n\n" if hidden else ''
            folder, cut = visible(job.get('cwd') or '~', 200, 1)
            text = f"Command:\n{block(command)}\n\nFolder: {folder}{'…' if cut else ''}"
            if job.get('stdin'):
                try:
                    data = bytes.fromhex(job['stdin']).decode().rstrip()
                    if '\0' in data:
                        raise ValueError('binary input')
                    script, hidden = visible(data, 1000, 20)
                    count = data.count('\n') + 1
                    text += f"\n\nInput ({count:,} line{'s' if count != 1 else ''}{', all shown' if not hidden else ''}):\n{block(script)}"
                    if hidden:
                        warnings += f"Warning: {hidden:,} more characters of its input are not shown, and will also run.\n\n"
                except ValueError:  # Not text, such as the archive a push unpacks.
                    warnings += f"Warning: the command also reads {len(job['stdin']) // 2:,} bytes of input that cannot be shown.\n\n"
            text = f"A cloud agent wants to change your Mac.\n\n{warnings}{text}"
            process = subprocess.Popen(['/usr/bin/osascript', '-e', ASK, text], stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, text=True, start_new_session=True)
            with self.lock:
                self.running[job['id']] = process
            answer = process.communicate()[0].strip()
            with self.lock:
                self.running.pop(job['id'], None)
            if answer == 'Allow for this sandbox':
                self.trusted.add(core.key)
            return answer in ('Allow', 'Allow for this sandbox')

    def track(self, level):
        """Any access level change, even Off and back, ends "Allow for this sandbox"."""
        if level != self.level:
            self.trusted, self.level = set(), level

    def refusal(self, core, job):
        """Why this job may not run as asked, or None. Everything else that is not full access runs read-only."""
        level = mac_level(self.enabled() or {})
        self.track(level)
        if level == 'off':
            return 'Mac access is off.'
        if level == 'full' or not job.get('write') and sys.platform == 'darwin' and level in ('read-only', 'ask'):
            return None
        if sys.platform != 'darwin':
            return 'Read-only and Ask first Mac access need macOS. The user can switch Mac access to Full in the Cloudroom sidebar.'
        if level == 'read-only':
            return 'Mac access is Read-only, so this command cannot change the Mac. The user can switch it to Ask first or Full in the Cloudroom sidebar.'
        if level == 'ask' and self.approve(core, job):
            return None
        return 'The user did not approve this command on their Mac. Do not retry it unless they ask you to.'

    def serve(self):
        """One job stream per reachable core: the VM's, and each awake sandbox's while it stays awake."""
        self.wanted, streams = set(), {}
        while True:
            with contextlib.suppress(OSError, ValueError, KeyError, TypeError):
                config = self.enabled()
                self.track(mac_level(config or {}))
                listed = {core.key: core for core in cores(config)} if config else {}
                self.wanted = set(listed)
                for key, core in listed.items():
                    if key not in streams or not streams[key].is_alive():
                        streams[key] = threading.Thread(target=self.follow, args=(core, config['device']), daemon=True)
                        streams[key].start()
            time.sleep(5)

    def follow(self, core, device):
        delay = 2
        while core.key in self.wanted:
            try:
                request = urllib.request.Request(core.url + '/v1/mac/jobs?device=' + device + '&boot=' + MAC_BOOT + '&fetch=true',
                                                 headers={**core.headers, 'Accept': 'text/event-stream'})
                with NET['opener'].open(request, timeout=60) as stream:
                    delay, event = 2, None
                    for raw in stream:
                        line = raw.decode().rstrip('\r\n')
                        if line.startswith('event:'):
                            event = line[6:].strip()
                        elif line.startswith('data:') and event == 'job':
                            threading.Thread(target=self.execute, args=(core, device, json.loads(line[5:])), daemon=True).start()
                        elif line.startswith('data:') and event == 'cancel':
                            self.cancel(json.loads(line[5:])['id'])
                        elif line.startswith(':') and (not self.enabled() or core.key not in self.wanted):
                            break
            except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException) as error:
                delay = min(delay * 2, 30)
                # A new sandbox refuses this Mac until it pairs; pair here instead of backing off until the preview loop does.
                if getattr(error, 'code', None) == 403:
                    with contextlib.suppress(OSError, ValueError):
                        core.request('/device', {'device': device, 'public_key': identity(self.folder)})
                        delay = 1
            with NUDGE:  # Check now wakes this wait.
                NUDGE.wait(delay)

    def execute(self, core, device, job):
        def post(body, timeout=MAC_POST_SECONDS):
            core.fetch(core.url + '/v1/mac/results/' + urllib.parse.quote(job['id']), {'device': device, **body}, None, core.headers,
                       timeout)
        # Run only once Core confirms it still wants the job. Core gives up on an unconfirmed job after about 10 s and tells
        # the agent it did not run, so running it anyway could change the Mac twice when the agent retries.
        confirmed, deadline = False, time.monotonic() + 30
        while not confirmed and time.monotonic() < deadline:
            try:
                post({'state': 'running'}, 10)
                confirmed = True
            except ControlError as error:
                if error.code in (401, 403, 404, 409):
                    return  # Core already gave up on this job and told the agent it did not run.
                time.sleep(1)
            except (OSError, ValueError):
                time.sleep(1)
        result = {'state': 'done', 'code': 127, 'stdout': '', 'stderr': '', 'truncated': False}
        # Core may have taken a confirmation whose reply was lost, so it still gets this result instead of waiting forever.
        job['stdin'] = mac_stdin(core, device, job) if confirmed else ''
        refused = ('The Mac could not confirm this command with the cloud, so it did not run. Try again.' if not confirmed else
                   "The Mac could not download this command's input from the cloud, so it did not run. Try again." if job['stdin'] is None else
                   self.refusal(core, job))
        # Refused commands are checked too, but a script file is read only for a command that will run.
        with contextlib.suppress(OSError, ValueError, KeyError, TypeError):
            review(core, job, mac_level(self.enabled() or {}), not refused)
        sandboxed = not refused and not job.get('write') and mac_level(self.enabled() or {}) != 'full'
        login = pwd.getpwuid(os.getuid()).pw_shell or '/bin/zsh'
        # Cloudroom's own tools (browser-harness) come first, as in Local threads, after the user's profile sets PATH.
        data = Path(core.config['connectionFile']).parent
        tools = shlex.quote(str(data / 'bin'))
        path = f'set -gx PATH {tools} $PATH; ' if login.endswith('/fish') else f'PATH={tools}:"$PATH"; '
        shell = [login, '-lc', path + job['command']]
        try:
            if refused:
                raise PermissionError(refused)
            folder = Path.home() / os.path.expanduser(job.get('cwd') or '~')
            with self.lock:  # A stop that arrives while the command starts either skips or kills it.
                if job['id'] in self.cancelled:
                    self.cancelled.discard(job['id'])
                    raise PermissionError('The agent stopped this command before it started, so it did not run.')
                process = subprocess.Popen([*read_only(data), *shell] if sandboxed else shell, cwd=folder,
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                self.running[job['id']] = process
        except OSError as error:
            result['code'] = 126 if isinstance(error, PermissionError) else 127
            result['stderr'] = str(error).encode().hex()
        else:
            output = {'stdout': bytearray(), 'stderr': bytearray()}
            def read(name):
                for chunk in iter(lambda: getattr(process, name).read1(65536), b''):
                    if len(output[name]) <= MAC_LIMIT:
                        output[name] += chunk
            def feed():
                with contextlib.suppress(OSError):
                    process.stdin.write(bytes.fromhex(job.get('stdin') or ''))
                    process.stdin.close()
            readers = [threading.Thread(target=read, args=(name,), daemon=True) for name in output]
            for thread in [*readers, threading.Thread(target=feed, daemon=True)]:
                thread.start()
            result['code'] = process.wait()
            for thread in readers:
                thread.join(2)  # A background process may keep the pipe open.
            with self.lock:
                self.running.pop(job['id'], None)
            # Blocked local connections fail as EPERM, or as curl's "couldn't connect".
            if sandboxed and result['code'] and any(sign in output['stderr'].lower() for sign in (b'not permitted', b'eperm', b"couldn't connect")):
                output['stderr'] += (b"\nCloudroom: Mac access is Read-only, so commands cannot change the Mac, reach its local servers or sockets, or read Cloudroom's files.\n"
                                     if mac_level(self.enabled() or {}) == 'read-only' else
                                     b"\nCloudroom: this ran read-only, without this Mac's local servers, sockets, or Cloudroom's files. To change the Mac or reach them, "
                                     b'rerun with `room-cli mac run --write ...`; the user approves it first.\n')
            result['truncated'] = any(len(value) > MAC_LIMIT for value in output.values())
            result.update({name: bytes(value[:MAC_LIMIT]).hex() for name, value in output.items()})
        # The result survives disconnects: retry until the VM accepts it, forgets the job, or an hour passes.
        deadline = time.monotonic() + 3600
        while time.monotonic() < deadline:
            try:
                deliver(post, result)
                return
            except ControlError as error:
                if error.code in (403, 404, 409, 413):
                    return
            except (OSError, ValueError):
                pass
            time.sleep(5)

    def cancel(self, job):
        with self.lock:
            process = self.running.get(job)
            if not process:
                self.cancelled.add(job)
        if process:
            def kill(signal_number):
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.killpg(process.pid, signal_number)
            kill(signal.SIGTERM)
            threading.Timer(2, kill, (signal.SIGKILL,)).start()


def run(folder):
    tunnels = {}
    ports_file = folder / 'ports.json'
    ports = private_json(ports_file) if ports_file.exists() else {}
    prepare_due, refresh, authenticated, delay = 0, True, 0, 2
    denied, credential, troubled, pairing = None, None, None, None
    # A restart (app launch, update, or a setting change) shows a problem it had already shown at once, if it is still there.
    with contextlib.suppress(OSError, ValueError):
        if private_json(folder / 'status.json').get('detail'):
            troubled = time.monotonic() - PROBLEM_SECONDS
    def stop(*_):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, stop)
    if not WINDOWS:  # Mac access is macOS and Linux only (macAccessSupported).
        threading.Thread(target=MacJobs(folder).serve, daemon=True).start()
    with (folder / 'lock').open('a') as lock:
        if WINDOWS:
            claim(folder, lock)
        else:
            exclusive(lock)
        try:
            while True:
                try:
                    config = private_json(folder / 'config.json')
                    listed = cores(config)
                    vm = next((core for core in listed if not core.sandbox), None)
                    if vm and credential != vm.headers:
                        credential, prepare_due, refresh, denied = vm.headers, 0, True, None
                    if config.pop('revoked', False):
                        save(folder / 'config.json', config)
                    if vm and refresh and time.monotonic() >= prepare_due:
                        prepare_due = time.monotonic() + 60
                        try:
                            vm.prepare()
                            refresh, denied = False, None
                        except (OSError, ValueError) as error:
                            if isinstance(error, ControlError) and error.code in (401, 403):
                                denied = error
                    if denied:
                        raise denied
                    desired, reached, failure = {}, 0, None
                    # Sandboxes first, so a VM that turns this Mac away can't block their Mac access.
                    for core in sorted(listed, key=lambda core: not core.sandbox):
                        try:
                            metadata = core.request('/device', {'device': config['device'], 'public_key': identity(folder)})
                            reached += core.sandbox
                            for entry in core.request('')['previews']:
                                port = entry['port']
                                if type(port) is not int or not 1024 <= port <= 65535 or not isinstance(entry['generation'], str):
                                    raise ValueError('Invalid preview registration')
                                desired[(core.key, port)] = (core, entry['generation'], metadata)
                        except (OSError, ValueError) as error:
                            if not core.sandbox:
                                raise  # A sandbox may fall asleep at any moment; the others keep working.
                            # An HTTP answer means this Mac reaches sandboxes and the sandbox side declined: paired with
                            # another Mac, still waking up, or about to leave the list. Only a network failure counts.
                            if getattr(error, 'code', None):
                                reached += 1
                            elif isinstance(cause(error), (OSError, http.client.HTTPException)):
                                failure = (error, core.url)
                    kind = type(cause(failure[0])) if failure and not reached else None
                    if kind is None:
                        PROBLEMS.pop('pairing', None)
                    elif kind is not pairing:  # Describe again only when the cause changes.
                        PROBLEMS['pairing'] = describe('pair', *failure)
                    pairing = kind
                    authenticated = time.monotonic()
                    failed = {key for key, tunnel in tunnels.items() if tunnel.process.poll() is not None}
                    refresh = refresh or bool(failed)
                    for key, tunnel in list(tunnels.items()):
                        wanted = desired.get(key)
                        if not wanted or wanted[1] != tunnel.generation or key in failed or tunnel.endpoint != wanted[2]:
                            tunnel.close(); del tunnels[key]
                    for key, (core, generation, metadata) in desired.items():
                        if key in tunnels:
                            continue
                        port = key[1]
                        name = f'{urllib.parse.urlsplit(core.url).hostname}:{port}' if core.sandbox else str(port)
                        local_port = ports.get(name, port)
                        if type(local_port) is not int or not 1024 <= local_port <= 65535:
                            local_port = port
                        try:
                            tunnels[key] = Tunnel(folder, core, port, generation, config['device'], metadata, config.get('allowPrivateSsh', False), local_port)
                        except OSError:
                            with contextlib.suppress(OSError, ValueError):
                                core.request('/report', {'device': config['device'], 'port': port, 'generation': generation,
                                                         'local_port': None, 'error': 'Local preview port unavailable'})
                            continue
                        ports[name] = tunnels[key].server.server_port
                        save(ports_file, ports)
                    def report(tunnel):
                        ready = tunnel.healthy()
                        error = None
                        if not ready:
                            if tunnel.process.poll() is not None:
                                error = 'Tunnel unavailable' if tunnel.relay else 'SSH connection unavailable'
                            elif reachable(tunnel.socket_path):
                                error = 'Cloud HTTP server unavailable'
                        try:
                            tunnel.core.request('/report', {'device': config['device'], 'port': tunnel.port, 'generation': tunnel.generation,
                                                            'local_port': tunnel.server.server_port if ready else None, 'error': error})
                        except ControlError as failure:
                            if failure.code != 409 and not tunnel.core.sandbox:
                                raise
                        except (OSError, ValueError):
                            if not tunnel.core.sandbox:
                                raise
                        return ready
                    with concurrent.futures.ThreadPoolExecutor() as pool:
                        ready = sum(pool.map(report, tunnels.values()))
                    # No awake sandbox reached: say why. A working VM keeps its previews; its own failures take the error path.
                    problem = None if vm or reached else PROBLEMS.get('sandboxes') or PROBLEMS.get('pairing')
                    troubled = (troubled or time.monotonic()) if problem else None
                    # Can't reach Cloudroom at all, twice in a row: no sandbox sleep explains that, so show it now.
                    fast = not reached and AWAKE['blocked'] >= 2
                    if problem and (fast or time.monotonic() - troubled >= PROBLEM_SECONDS):
                        save(folder / 'status.json', {'state': 'offline', 'message': problem[0], 'detail': problem[1], 'checkedAt': int(time.time() * 1000)})
                    else:
                        save(folder / 'status.json', {'state': 'connected', 'count': len(tunnels), 'ready': ready, 'checkedAt': int(time.time() * 1000)})
                    delay = 2
                except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
                    refresh = True
                    if time.monotonic() - NET['at'] >= NETWORK_SECONDS:
                        network()  # An unreachable VM may sit behind a proxy that just changed.
                    transient = isinstance(error, (OSError, ControlError)) and not (isinstance(error, ControlError) and error.code not in (429, 500, 502, 503, 504))
                    if not transient or time.monotonic() - authenticated >= 15:
                        for tunnel in tunnels.values():
                            tunnel.close()
                        tunnels.clear()
                    save(folder / 'status.json', {'state': 'offline', 'message': str(error) if isinstance(error, ValueError) else 'Preview connection unavailable; reconnecting automatically', 'checkedAt': int(time.time() * 1000)})
                    delay = min(delay * 2, 30) if not tunnels else 2
                time.sleep(delay)
        except KeyboardInterrupt:
            pass
        finally:
            for tunnel in tunnels.values():
                tunnel.close()


def label(folder):
    import hashlib
    return 'dev.cloudroom.preview.' + hashlib.sha256(str(folder).encode()).hexdigest()[:16]


def systemd(folder, label, stop):
    unit = label + '.service'
    path = Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config') / 'systemd/user' / unit
    def systemctl(*args):
        subprocess.run(['systemctl', '--user', *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if stop:
        if path.exists():
            systemctl('disable', '--now', unit)
            path.unlink()
            systemctl('daemon-reload')
        return
    quote = lambda value: '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'
    command = ' '.join(quote(part) for part in [sys.executable, '-B', '-E', '-s', folder / 'client.py', 'run', folder])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f'[Service]\nExecStart={command}\nEnvironment={quote("PATH=" + os.environ.get("PATH", os.defpath))}\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n')
    systemctl('daemon-reload')
    systemctl('enable', '--now', unit)


# Runs the helper under the signed Cloudroom app, so macOS applies Cloudroom's Desktop/Documents/Downloads permission, not python3's.
LAUNCHER = ("const e={...process.env};delete e.ELECTRON_RUN_AS_NODE;"
            "const c=require('child_process').spawn(process.argv[1],process.argv.slice(2),{stdio:'inherit',env:e});"
            "for(const s of['SIGTERM','SIGINT','SIGHUP'])process.on(s,()=>c.kill(s));c.on('exit',code=>process.exit(code??1))")


def running(folder):
    """Whether a helper holds this folder's lock."""
    with (folder / 'lock').open('a') as lock:
        try:
            exclusive(lock)
        except BlockingIOError:
            return True
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
        return False


def claim(folder, lock):
    """Windows: take the folder's lock (a running() check may hold it for a moment), drop an old stop request, confirm the
    start to the launcher, and exit as soon as a stop request arrives."""
    deadline = time.monotonic() + 5
    while True:
        try:
            exclusive(lock)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(.05)
    (folder / 'stop').unlink(missing_ok=True)
    if os.environ.get('CLOUDROOM_PREVIEW_START'):
        (folder / 'started').write_text(os.environ['CLOUDROOM_PREVIEW_START'])
    def watch():
        while not (folder / 'stop').exists():
            time.sleep(.2)
        os._exit(0)
    threading.Thread(target=watch, daemon=True).start()


@contextlib.contextmanager
def serialized(folder):
    """Windows: one start or stop at a time."""
    with (folder / 'control.lock').open('a') as lock:
        deadline = time.monotonic() + 30
        while True:
            try:
                exclusive(lock)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise OSError('Another preview start or stop is still running')
                time.sleep(.1)
        try:
            yield
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def windows(folder, stop):
    """Windows has no launchd: a detached helper runs until sign-out or logoff, and each app launch restarts it. A start
    waits for the helper to confirm; a stop asks it to exit. Nothing is ended by a process id read from a file."""
    with serialized(folder):
        if stop:
            if running(folder):
                (folder / 'stop').write_text('')
            deadline = time.monotonic() + 10
            while running(folder):
                if time.monotonic() >= deadline:
                    raise OSError('Preview helper did not stop')
                time.sleep(.1)
            return
        start = uuid.uuid4().hex
        (folder / 'started').unlink(missing_ok=True)
        command = [sys.executable, '-B', '-E', '-s', str(folder / 'client.py'), 'run', str(folder)]
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        for extra in (subprocess.CREATE_BREAKAWAY_FROM_JOB, 0):  # Outlive the app's job object when it allows that.
            try:
                process = subprocess.Popen(command, creationflags=flags | extra, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL, close_fds=True, env={**os.environ, 'CLOUDROOM_PREVIEW_START': start})
                break
            except OSError:
                if not extra:
                    raise
        deadline = time.monotonic() + 15
        while True:
            with contextlib.suppress(OSError):
                if (folder / 'started').read_text() == start:
                    return
            if process.poll() is not None or time.monotonic() >= deadline:
                process.kill()  # Our own child's handle, never a stale id: a helper that missed its start never runs late.
                raise OSError('Preview helper did not start')
            time.sleep(.1)


def launch(folder, stop=False):
    if sys.platform.startswith('linux'):
        return systemd(folder, label(folder), stop)
    if WINDOWS:
        return windows(folder, stop)
    if sys.platform != 'darwin':
        raise ValueError('Use run for foreground helpers outside macOS and Linux')
    name = label(folder)
    domain = f'gui/{os.getuid()}'
    path = Path.home() / 'Library/LaunchAgents' / (name + '.plist')
    if stop:
        subprocess.run(['launchctl', 'bootout', domain + '/' + name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 10
        while subprocess.run(['launchctl', 'print', domain + '/' + name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            if time.monotonic() >= deadline:
                raise OSError('Preview helper did not stop')
            time.sleep(.1)
        with (folder / 'lock').open('a') as lock:
            while True:
                try:
                    exclusive(lock)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise OSError('Previous preview helper is still shutting down')
                    time.sleep(.1)
        path.unlink(missing_ok=True); return
    command = [sys.executable, '-B', '-E', '-s', str(folder / 'client.py'), 'run', str(folder)]
    # Not ProcessType Background: macOS then throttles the helper's CPU and network, and on a busy Mac it misses
    # Core's Mac job deadlines (30 s to attach, 10 s to answer), so cloud agents see 'Mac unavailable'.
    job = {'Label': name, 'ProgramArguments': command, 'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 5}
    launcher = private_json(folder / 'config.json').get('launcher')
    if launcher:
        job.update(ProgramArguments=[launcher, '-e', LAUNCHER, *command], EnvironmentVariables={'ELECTRON_RUN_AS_NODE': '1'})
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('wb') as file:
        plistlib.dump(job, file)
    subprocess.run(['launchctl', 'bootstrap', domain, str(path)], check=True, capture_output=True)


def configure(folder, connection_file, activate, allow_private, mac_access=None, launcher=None, restart=False, own=False):
    folder.mkdir(mode=0o700, parents=True, exist_ok=True); folder.chmod(0o700)
    connection = private_json(connection_file)
    # Sandbox-only accounts have no VM address; their cores come from the website while awake.
    binding = [(connection.get('url') or 'sandboxes').rstrip('/'), (connection.get('account') or {}).get('id')]
    old = private_json(folder / 'config.json') if (folder / 'config.json').exists() else None
    # The same account may move from its VM to sandboxes; another account never reuses this setup.
    if old and old['binding'][1] != binding[1]:
        raise ValueError('Preview setup belongs to another account; use a separate directory')
    source = Path(__file__).resolve()
    target = folder / 'client.py'
    allow_private = bool(allow_private if allow_private is not None else (old or {}).get('allowPrivateSsh', False))
    mac_access = mac_access if mac_access is not None else mac_level(old or {})
    # App updates replace these files; restart so macOS can still name the helper for Desktop/Documents/Downloads access.
    # restart: each app launch also restarts the helper so newly granted Full Disk Access applies.
    binary = [os.stat(path).st_ino for path in (launcher, sys.executable) if path]
    # A self-hosted website (the app's CLOUDROOM_WEBSITE_URL); launchd starts the helper without the app's environment.
    trusted = os.environ.get('CLOUDROOM_WEBSITE_URL', '').strip().rstrip('/')
    trusted = trusted if trusted.startswith('https://') else None
    if (activate and not restart and old and old['binding'] == binding and old.get('connectionFile') == str(connection_file)
            and old.get('allowPrivateSsh', False) == allow_private and old.get('macAccess') == mac_access
            and old.get('launcher') == launcher and old.get('binary') == binary and old.get('ownThreads', False) == own
            and old.get('website') == trusted and target.is_file() and target.read_bytes() == source.read_bytes()):
        if WINDOWS:
            if running(folder):
                return {'enabled': True}
        else:
            check = ['systemctl', '--user', 'is-active', '--quiet', label(folder) + '.service'] if sys.platform.startswith('linux') else ['launchctl', 'print', f'gui/{os.getuid()}/' + label(folder)]
            if subprocess.run(check, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                return {'enabled': True}
    if activate:
        launch(folder, stop=True)
    if source != target:
        temporary = folder / 'client.pending'
        temporary.write_bytes(source.read_bytes()); temporary.chmod(0o600); temporary.replace(target)
    config = {'device': old['device'] if old else uuid.uuid4().hex, 'binding': binding, 'connectionFile': str(connection_file),
              'allowPrivateSsh': allow_private, 'macAccess': mac_access, 'launcher': launcher, 'binary': binary, **({'ownThreads': True} if own else {}),
              **({'website': trusted} if trusted else {})}
    save(folder / 'config.json', config)
    identity(folder)
    if activate:
        launch(folder)
    return {'enabled': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['configure', 'run', 'status', 'stop', 'pause'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('--connection', type=Path)
    parser.add_argument('--no-start', action='store_true')
    parser.add_argument('--allow-private-ssh', action='store_true', default=None, help='Explicitly allow a self-hosted private/loopback SSH address')
    parser.add_argument('--mac-access', choices=['on', *MAC_LEVELS], help='How much cloud agents may do on this Mac (ADR 0113, 0186); on means full')
    parser.add_argument('--launcher', type=Path, help='Signed Cloudroom executable that starts the macOS helper in Node mode')
    parser.add_argument('--restart', action='store_true', help='Restart a running helper even if its setup is unchanged')
    parser.add_argument('--own-threads', action='store_true', help='Cloudroom Dev: use only the sandboxes of threads this app woke')
    args = parser.parse_args()
    folder = args.directory.expanduser().resolve()
    if args.command == 'configure':
        if args.connection is None:
            raise ValueError('--connection is required')
        print(json.dumps(configure(folder, args.connection.expanduser().resolve(strict=True), not args.no_start, args.allow_private_ssh,
                                   'full' if args.mac_access == 'on' else args.mac_access,
                                   str(args.launcher.resolve(strict=True)) if args.launcher else None, args.restart, args.own_threads)))
    elif args.command == 'run':
        run(folder)
    elif args.command in {'stop', 'pause'}:
        launch(folder, stop=True)
        if args.command == 'pause':
            save(folder / 'status.json', {'state': 'offline', 'checkedAt': int(time.time() * 1000)})
            print('{"paused":true}')
            return
        config = private_json(folder / 'config.json')
        if not config.get('revoked', False):
            # Best effort: a sleeping sandbox or an archived VM must never block sign-out.
            for core in cores(config):
                with contextlib.suppress(OSError, ValueError):
                    core.request('/device/' + config['device'], method='DELETE')
            config['revoked'] = True
            save(folder / 'config.json', config)
        save(folder / 'status.json', {'state': 'offline', 'checkedAt': int(time.time() * 1000)})
        print('{"stopped":true}')
    else:
        print(json.dumps(private_json(folder / 'status.json')))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(str(error) if isinstance(error, ValueError) else 'Preview setup failed; inspect private configuration, SSH access, and macOS background-job permissions', file=sys.stderr)
        sys.exit(1)
