#!/usr/bin/env python3
"""Skills/settings sync, one-way MCP server copy, and one-way Codex and Pi setup import. Project files never sync."""
import argparse
import fcntl
import functools
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import ssl
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from files import MCP, Conflict, Tree, atomic_json, excluded


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('core redirects are not accepted')


def private_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as source:
        if os.fstat(source.fileno()).st_mode & 0o077:
            raise ValueError('configuration must be private')
        return json.load(source)


def tls():
    bundled = os.path.join(sys.prefix, 'cacert.pem')
    return ssl.create_default_context(cafile=bundled if os.path.isfile(bundled) and not os.environ.get('SSL_CERT_FILE') else None)


class Remote:
    def __init__(self, connection, device):
        parsed = urllib.parse.urlsplit(connection['url'])
        if (parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in {'127.0.0.1', 'localhost', '::1'})) or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('use an HTTPS core address')
        token = connection.get('token', '')
        gate = connection.get('gateToken')
        if not token or any(ord(c) < 33 or ord(c) > 126 for c in token):
            raise ValueError('sign in required')
        if gate is not None and (not gate or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~-' for c in gate)):
            raise ValueError('invalid hosting gate token')
        self.url, self.device = connection['url'].rstrip('/'), device
        self.headers = {'Authorization': 'Bearer ' + token, **({'Cookie': '_port_auth=' + gate} if gate else {})}
        self.opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=tls()))

    def request(self, path, body=None, method=None, headers=None, timeout=60):
        request = urllib.request.Request(self.url + path, data=body, method=method, headers={**self.headers, **(headers or {})})
        try:
            return self.opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            error.close()
            if error.code in {409, 412}:
                raise Conflict('remote changed') from None
            raise OSError(f'Core returned HTTP {error.code} for {urllib.parse.urlsplit(path).path}') from None

    def json(self, path, value=None):
        body = json.dumps(value).encode() if value is not None else None
        with self.request(path, body, headers={'Content-Type': 'application/json'}) as response:
            data = response.read(16 * 1024 * 1024 + 1)
            if len(data) > 16 * 1024 * 1024:
                raise ValueError('core JSON response exceeds the existing client limit')
            return json.loads(data)

    def path(self, root, file=None, **args):
        return '/v1/sync/' + urllib.parse.quote(root, safe='') + ('/file' if file is not None else '') + '?' + urllib.parse.urlencode({'device': self.device, **({'path': file} if file is not None else {}), **{k: str(v).lower() if isinstance(v, bool) else v for k,v in args.items() if v is not None}})

    def scan(self, root):
        return self.json(self.path(root))

    def upload(self, root, path, expected, entry, data):
        url = self.path(root, path, expected=expected, **({'kind':entry['kind'], 'executable':entry['executable'], 'incoming':entry['tag'], 'size':entry['size']} if entry else {}))
        with self.request(url, data if entry else b'', method='PUT', headers={'Content-Length': str(entry['size'] if entry else 0), 'Content-Type': 'application/octet-stream'}) as response:
            return json.load(response)


def configuration_roots(roots):
    return [r for r in roots if r['tree']['kind'] in {'skills', 'codex', 'pi', 'claude', 'cursor', *MCP}]


def import_codex(config, connection, folder):
    folder = Path(folder)
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (folder / 'codex-import.lock').open('a') as lock:
        os.chmod(folder / 'codex-import.lock', 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not config.get('copyLogins'):
            return None  # The user said no in first-run setup (ADR 0130).
        remote = Remote(connection, config.get('device', ''))
        capabilities = remote.json('/v1/capabilities')
        if not capabilities.get('codex_auth_import'):
            return None
        status = remote.json('/v1/accounts/codex')
        if status['state'] != 'missing':
            return status
        home = config.get('codexHome') or os.environ.get('CODEX_HOME') or Path.home() / '.codex'
        path = Path(home).expanduser() / 'auth.json'
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
                    return status
                raw = source.read(64 * 1024 + 1)
            if len(raw) > 64 * 1024:
                return status
            value = json.loads(raw)
            if (not isinstance(value, dict) or value.get('auth_mode', 'chatgpt') != 'chatgpt'
                    or value.get('OPENAI_API_KEY') is not None or not isinstance(value.get('tokens'), dict)):
                return status
            keys = ['id_token', 'access_token', 'refresh_token', 'account_id']
            if any(not isinstance(value['tokens'].get(key), str) or not value['tokens'][key] for key in keys):
                return status
            credentials = {'auth_mode': 'chatgpt', 'OPENAI_API_KEY': None,
                           'tokens': {key: value['tokens'][key] for key in keys}}
            if isinstance(value.get('last_refresh'), str):
                credentials['last_refresh'] = value['last_refresh']
        except (OSError, ValueError):
            return status
        attempt = {'binding': [connection['url'].rstrip('/'), (connection.get('account') or {}).get('id')],
                   'fingerprint': hashlib.sha256(raw).hexdigest()}
        receipt = folder / 'codex-import.json'
        if receipt.exists() and private_json(receipt) == attempt:
            return status
        status = remote.json('/v1/accounts/codex/import', credentials)
        if status['state'] in {'connected', 'limited', 'missing'}:
            atomic_json(receipt, attempt)
        return status


@functools.cache
def login_shell_env():
    """Keys exported in ~/.zshrc are invisible to this background helper, so ask the user's shell once."""
    try:
        output = subprocess.run([os.environ.get('SHELL') or '/bin/zsh', '-ilc', 'env -0'], capture_output=True, timeout=15, stdin=subprocess.DEVNULL).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    return dict(item.split('=', 1) for item in output.decode(errors='replace').split('\0') if '=' in item)


def resolved(value):
    """A Pi key as the Mac sees it, following Pi's rules: `!command` output or `$VAR` values. None when unresolved.
    The VM cannot run Mac commands, such as Keychain lookups, or see Mac variables."""
    if not isinstance(value, str) or not value:
        return None
    if value.startswith('!'):
        try:
            run = subprocess.run(['/bin/sh', '-c', value[1:]], capture_output=True, text=True, timeout=15, stdin=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError):
            return None
        return run.stdout.strip() if run.returncode == 0 and run.stdout.strip() else None
    missing = []
    def variable(match):
        name = match[1] or match[2]
        found = os.environ.get(name) or login_shell_env().get(name)
        missing.extend([] if found else [name])
        return found or ''
    value = re.sub(r'\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)', variable, value)
    return None if missing else value


def portable_provider(provider):
    provider = dict(provider)
    if 'apiKey' in provider:
        provider['apiKey'] = resolved(provider['apiKey'])
        if provider['apiKey'] is None:
            del provider['apiKey']
    if isinstance(provider.get('headers'), dict):
        provider['headers'] = {name: value for name, value in ((n, resolved(v)) for n, v in provider['headers'].items()) if value is not None}
    return provider


def pi_file(home, name):
    """A Pi file this user owns and nobody else can change. Login files must also be private."""
    try:
        fd = os.open(Path(home).expanduser() / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & (0o077 if name == 'auth.json' else 0o022) or info.st_uid != os.getuid():
                return b''
            raw = source.read(256 * 1024 + 1)
        return raw if len(raw) <= 256 * 1024 else b''
    except OSError:
        return b''


def pi_setup(home):
    """The Mac's custom Pi providers, with keys as the Mac sees them, and packages (ADR 0130). Cloud sandboxes get them at Pi start."""
    models, settings = (json.loads(raw) if raw else {} for raw in (pi_file(home, 'models.json'), pi_file(home, 'settings.json')))
    providers = models.get('providers') if isinstance(models, dict) and isinstance(models.get('providers'), dict) else {}
    packages = settings.get('packages') if isinstance(settings, dict) and isinstance(settings.get('packages'), list) else []
    return {'providers': {name: portable_provider(value) for name, value in providers.items() if isinstance(value, dict)}, 'packages': packages}


def import_pi(config, connection, folder):
    """Copy Pi logins the VM lacks, custom providers, and packages (ADR 0130). VM logins always win."""
    if not config.get('copyLogins'):
        return None  # The user said no in first-run setup.
    home = config.get('piHome') or os.environ.get('PI_CODING_AGENT_DIR') or Path.home() / '.pi/agent'
    files = [pi_file(home, name) for name in ('auth.json', 'models.json', 'settings.json')]
    try:
        logins, models, settings = (json.loads(raw) if raw else {} for raw in files)
    except ValueError:
        return None
    if not all(isinstance(value, dict) for value in (logins, models, settings)):
        return None
    attempt = {'binding': [connection['url'].rstrip('/'), (connection.get('account') or {}).get('id')],
               'fingerprint': hashlib.sha256(b'\0'.join(files)).hexdigest()}
    receipt = Path(folder) / 'pi-import.json'
    if receipt.exists() and private_json(receipt) == attempt:
        return None
    remote = Remote(connection, config.get('device', ''))
    capabilities = remote.json('/v1/capabilities')
    if not capabilities.get('pi_auth_import'):
        return None
    saved = set(remote.json('/v1/accounts/pi')['providers'])
    missing = {}
    for name, entry in logins.items():
        if name in saved or not isinstance(entry, dict):
            continue
        if entry.get('type') == 'api_key':
            entry = {**entry, 'key': resolved(entry.get('key'))}
        if entry.get('key', True):
            missing[name] = entry
    result = remote.json('/v1/accounts/pi/import', missing) if missing else {'providers': sorted(saved), 'added': []}
    setup = pi_setup(home)
    if capabilities.get('pi_setup') and (setup['providers'] or setup['packages']):
        result['setup'] = remote.json('/v1/accounts/pi/setup', setup)
    atomic_json(receipt, attempt)
    return result


def cycle(config, connection, state_dir):
    remote = Remote(connection, config['device'])
    try:
        import_codex(config, connection, state_dir)
    except (OSError, Conflict, ValueError, KeyError, TypeError):
        pass  # Login recovery must not stop independent skills/settings sync.
    try:
        import_pi(config, connection, state_dir)
    except (OSError, Conflict, ValueError, KeyError, TypeError):
        pass
    roots = configuration_roots(config['roots'])
    capabilities = remote.json('/v1/capabilities')
    if not capabilities.get('mcp_sync'):
        roots = [r for r in roots if r['tree']['kind'] not in MCP]  # Older cores reject unknown roots.
    if not (config.get('copyLogins') and capabilities.get('pi_setup')):
        roots = [r for r in roots if r['id'] != 'extensions-pi']  # Pi extensions can register providers (ADR 0130).
    remote.json('/v1/sync', {'device': config['device']})
    details = {}
    for root in roots:
        identity = root['id']
        state_path = state_dir / (identity + '.json')
        previous = private_json(state_path) if state_path.exists() else {'base': {}, 'cache': {}, 'conflicts': []}
        base = previous['base']
        tree = Tree(**root['tree'])
        conflicts = []
        try:
            local, cloud = tree.scan(previous.get('cache')), remote.scan(identity)
            skipped = local.get('skipped', []) + cloud.get('skipped', [])
            conflicts.extend(skipped)
            for path in sorted(set(base) | set(local['files']) | set(cloud['files'])):
                # The Mac and the cloud each ship their own room-cli skill; never mirror it.
                if excluded(path) or any(path == prefix or path.startswith(prefix + '/') for prefix in skipped) \
                        or (tree.kind == 'skills' and path.split('/')[0] == 'room-cli'):
                    continue
                left, right = local['files'].get(path), cloud['files'].get(path)
                a, b, old = (left or {}).get('tag'), (right or {}).get('tag'), base.get(path)
                # Mac to VM only: never edit the Mac's agent configuration or copy VM code that Pi would run on the Mac.
                push = tree.kind in MCP or identity == 'extensions-pi'
                if a == b:
                    base[path] = a
                    continue
                if push and a in {None, old}:
                    continue
                if a != old and b != old and not push:
                    conflicts.append(path)
                    continue
                try:
                    if b == old or push:
                        if left:
                            with tree.snapshot(path) as (entry, data):
                                if entry['tag'] != a:
                                    raise Conflict('local changed')
                                remote.upload(identity, path, b, entry, data)
                        else:
                            remote.upload(identity, path, b, None, None)
                        base[path] = a
                    else:
                        if right:
                            with remote.request(remote.path(identity, path, expected=b)) as data:
                                tree.apply(path, a, right, data)
                        else:
                            tree.apply(path, a, None, None)
                        base[path] = b
                    atomic_json(state_path, {'base': base, 'cache': {}, 'conflicts': conflicts})
                except Conflict:
                    conflicts.append(path)
            atomic_json(state_path, {'base': base, 'cache': local['files'], 'conflicts': conflicts})
            details[identity] = {'state': 'conflict' if conflicts else 'synced', 'conflicts': len(conflicts)}
        except Conflict:
            details[identity] = {'state': 'conflict', 'issue': 'Resolve conflicting files or case collisions.'}
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            details[identity] = {'state': 'offline', 'issue': 'Check sync access, supported file types, and available disk space.'}
    states = {identity: detail['state'] for identity, detail in details.items()}
    remote.json('/v1/sync', {'device': config['device'], 'states': states})
    return {'state': 'conflict' if 'conflict' in states.values() else 'offline' if 'offline' in states.values() else 'synced', 'roots': details, 'checkedAt': int(time.time() * 1000)}


def load_connection(config):
    connection = private_json(config['connectionFile'])
    binding = [connection['url'].rstrip('/'), (connection.get('account') or {}).get('id')]
    if config['binding'] != binding:
        raise ValueError('connection changed; review sync setup again')
    return connection


def run(folder, once=False):
    folder = Path(folder).resolve(strict=True)
    with (folder / 'lock').open('a') as lock:
        os.chmod(folder / 'lock', 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        while True:
            started = time.monotonic()
            try:
                config = private_json(folder / 'config.json')
                status = cycle(config, load_connection(config), folder)
            except (OSError, Conflict, ValueError, KeyError, TypeError):
                status = {'state': 'offline', 'issue': 'Sync cannot connect. Check account setup and core access.', 'checkedAt': int(time.time() * 1000)}
            atomic_json(folder / 'status.json', status)
            if once:
                return status
            time.sleep(max(0, 5 - (time.monotonic() - started)))


def discover(home):
    codex = Path(os.environ.get('CODEX_HOME') or home / '.codex').expanduser()
    pi = Path(os.environ.get('PI_CODING_AGENT_DIR') or home / '.pi/agent').expanduser()
    claude = home / '.claude'
    roots = []
    for identity, path in [('shared', home / '.agents'), ('codex', codex), ('pi', pi), ('claude', claude), ('cursor', home / '.cursor')]:
        if (path / 'skills').is_dir():
            roots.append({'id': 'skills-' + identity, 'tree': {'root': str((path / 'skills').resolve()), 'kind': 'skills'}})
        filename = 'config.toml' if identity == 'codex' else 'cli-config.json' if identity == 'cursor' else 'settings.json'
        if identity == 'pi' and (path / 'extensions').is_dir():
            roots.append({'id': 'extensions-pi', 'tree': {'root': str((path / 'extensions').resolve()), 'kind': 'skills'}})
        if identity == 'cursor' and (path / 'rules').is_dir():
            roots.append({'id': 'rules-cursor', 'tree': {'root': str((path / 'rules').resolve()), 'kind': 'skills'}})
        if identity != 'shared' and (path / filename).is_file():
            roots.append({'id': 'settings-' + identity, 'tree': {'root': str(path.resolve()), 'kind': identity, 'filename': filename}})
    for identity, path, filename in [('codex', codex, 'config.toml'), ('claude', home, '.claude.json'), ('cursor', home / '.cursor', 'mcp.json')]:
        if (path / filename).is_file():
            roots.append({'id': 'mcp-' + identity, 'tree': {'root': str(path.resolve()), 'kind': 'mcp-toml' if filename.endswith('.toml') else 'mcp-json', 'filename': filename}})
    return roots


def launch_identity(folder):
    return 'dev.cloudroom.sync.' + hashlib.sha256(str(folder).encode()).hexdigest()[:16]


def launch(folder, stop=False):
    if sys.platform != 'darwin':
        raise ValueError('automatic installation supports macOS; use run on other systems')
    label = launch_identity(folder)
    domain = f'gui/{os.getuid()}'
    path = Path.home() / 'Library/LaunchAgents' / (label + '.plist')
    if stop:
        subprocess.run(['launchctl', 'bootout', domain + '/' + label], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 10
        while subprocess.run(['launchctl', 'print', domain + '/' + label], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            if time.monotonic() >= deadline:
                raise OSError('Sync helper did not stop within 10 seconds')
            time.sleep(.1)
        with (folder / 'lock').open('a') as lock:
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise OSError('Previous sync helper is still shutting down')
                    time.sleep(.1)
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('wb') as output:
        plistlib.dump({'Label': label, 'ProgramArguments': [sys.executable, '-B', '-E', '-s', str(folder / 'client.py'), 'run', str(folder)], 'EnvironmentVariables': {'PATH': os.environ.get('PATH', os.defpath)}, 'RunAtLoad': True, 'KeepAlive': True, 'ProcessType': 'Background', 'ThrottleInterval': 5}, output)
    subprocess.run(['launchctl', 'bootstrap', domain, str(path)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def configure(folder, connection_file, activate=True, copy_logins=None):
    folder = Path(folder).expanduser().resolve()
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    folder.chmod(0o700)
    with (folder / 'configure.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        connection_file = Path(connection_file).expanduser().resolve(strict=True)
        connection = private_json(connection_file)
        binding = [connection['url'].rstrip('/'), (connection.get('account') or {}).get('id')]
        old = private_json(folder / 'config.json') if (folder / 'config.json').exists() else None
        if old and old['binding'] != binding:
            raise ValueError('sync belongs to another account/core; use a separate local sync directory')
        if activate:
            launch(folder, stop=True)
        # Keep old repository baselines and recovery copies on disk, but never use them again.
        roots = configuration_roots(old['roots']) if old else discover(Path.home())
        # Existing installs keep their roots; only add MCP and Pi extension roots introduced later.
        roots += [r for r in discover(Path.home()) if old and (r['tree']['kind'] in MCP or r['id'] == 'extensions-pi') and r['id'] not in {x['id'] for x in roots}]
        for name in ['client.py', 'files.py']:
            source, target = Path(__file__).parent / name, folder / name
            if source.resolve() != target.resolve():
                temporary = folder / ('.sync-' + name)
                shutil.copyfile(source, temporary); temporary.chmod(0o600); temporary.replace(target)
        legacy_home = next((r['tree']['root'] for r in (old or {}).get('roots', []) if r['id'] == 'auth-codex'), None)
        codex_home = os.environ.get('CODEX_HOME') or (old or {}).get('codexHome') or legacy_home or Path.home() / '.codex'
        pi_home = os.environ.get('PI_CODING_AGENT_DIR') or (old or {}).get('piHome') or Path.home() / '.pi/agent'
        config = {'device': old['device'] if old else uuid.uuid4().hex, 'connectionFile': str(connection_file), 'binding': binding, 'roots': roots,
                  'codexHome': str(Path(codex_home).expanduser().resolve()), 'piHome': str(Path(pi_home).expanduser().resolve()),
                  'copyLogins': bool((old or {}).get('copyLogins')) if copy_logins is None else copy_logins}
        atomic_json(folder / 'config.json', config)
        if activate:
            launch(folder)
        return {'enabled': True, 'roots': [r['id'] for r in roots]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['configure', 'run', 'once', 'auth', 'pi-auth', 'pi-setup', 'status', 'stop'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('--connection', type=Path)
    parser.add_argument('--no-start', action='store_true', help='Prepare configuration without installing a background job')
    parser.add_argument('--copy-logins', choices=['on', 'off'], help="The user's first-run choice to copy logins and model providers to the VM")
    args = parser.parse_args()
    if args.command == 'configure':
        result = configure(args.directory, args.connection, not args.no_start, None if args.copy_logins is None else args.copy_logins == 'on')
    elif args.command in {'run', 'once'}:
        result = run(args.directory, args.command == 'once')
    elif args.command in {'auth', 'pi-auth'}:
        config_path = args.directory / 'config.json'
        config = private_json(config_path) if config_path.exists() else {}
        connection = load_connection(config) if config else private_json(args.connection)
        result = (import_codex if args.command == 'auth' else import_pi)(config, connection, args.directory)
    elif args.command == 'pi-setup':
        result = pi_setup(os.environ.get('PI_CODING_AGENT_DIR') or Path.home() / '.pi/agent')
    elif args.command == 'stop':
        launch(args.directory.resolve(), stop=True)
        result = {'state': 'offline'}
    else:
        result = private_json(args.directory / 'status.json')
    if result is not None:
        print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        message = f'Sync shutdown failed: {error}' if sys.argv[1:2] == ['stop'] else 'Sync setup failed. Check Python 3.11+, private connection settings, folder permissions, and macOS background-job access.'
        print(message, file=sys.stderr)
        sys.exit(1)
