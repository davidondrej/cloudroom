"""Shared, dependency-free file operations for the core and its local sync client."""
import contextlib
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile
import uuid
import unicodedata
try:
    import tomllib
except ImportError:
    tomllib = None

# Never replicate live Git databases, caches, or our own recovery state.
EXCLUDED = {'.git', 'node_modules', '.cache', '__pycache__', '.venv', 'venv', '.next', '.turbo', '.pnpm-store', 'target', '.DS_Store', '.cloudroom-imported'}
PENDING = '.cloudroom-sync-pending'
CHUNK = 64 * 1024
MAX_FILE_BYTES = 4 * 1024**3
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
PORTABLE = {
    'pi': {'defaultProvider', 'defaultModel', 'defaultThinkingLevel', 'hideThinkingBlock', 'quietStartup'},
    'claude': {'model', 'effortLevel', 'language'},
    'cursor': {'notifications', 'hints', 'suggestNextPrompt'},
    'codex': {'model', 'model_reasoning_effort', 'model_verbosity', 'personality'},
    'mcp-json': {'mcpServers'},
    'mcp-toml': {'mcp_servers'},
}
# MCP servers copy one way, Mac to VM, and only add or update. Secrets and machine-specific
# setup stay local: the VM cannot use Mac paths, environment variables, or keychain logins.
MCP = {'mcp-json': 'mcpServers', 'mcp-toml': 'mcp_servers'}
MCP_LOCAL_KEYS = {'env', 'env_vars', 'headers', 'http_headers', 'env_http_headers', 'bearer_token_env_var', 'cwd'}
# Conservative: a false match only keeps that server on the Mac. Catches key prefixes anywhere,
# UUIDs, and long random-looking runs, such as keys embedded in MCP URL paths.
MCP_SECRET = re.compile(r'(?i)api[-_]?key|token|secret|password|bearer|(?<![a-z0-9])(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr])[-_]'
                        r'|[0-9a-f]{8}-[0-9a-f]{4}-|(?<![a-z0-9_])(?=[a-z_]*[0-9])[a-z0-9_]{24,}')


class Conflict(Exception):
    pass


def portable_mcp(name, server):
    if (not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', name) or not isinstance(server, dict) or server.keys() & MCP_LOCAL_KEYS
            or not all(re.fullmatch(r'[A-Za-z0-9_-]+', key) for key in server)):
        return False
    for value in server.values():
        for item in value if isinstance(value, list) else [value]:
            if isinstance(item, float) and item == item and abs(item) != float('inf'):
                continue
            if not isinstance(item, (str, bool, int)) or isinstance(item, str) and (
                    item.startswith(('/', '~')) or '/Users/' in item or MCP_SECRET.search(item)):
                return False
    url, command = server.get('url'), server.get('command')
    if url is not None:
        return command is None and isinstance(url, str) and url.startswith('https://') and '?' not in url
    return isinstance(command, str) and bool(command) and '/' not in command


def excluded(path):
    return any(part in EXCLUDED or part.startswith('.cloudroom-sync-') for part in path.split('/'))


def atomic_json(path, value):
    path = Path(path)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.sync-')
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output, separators=(',', ':'))
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, path)
        with directory(path.parent) as parent:
            os.fsync(parent)
    finally:
        Path(name).unlink(missing_ok=True)


@contextlib.contextmanager
def directory(path, create=False):
    path = Path(path)
    if not path.is_absolute():
        raise ValueError('absolute root required')
    fd = os.open('/', DIRECTORY)
    try:
        for part in path.parts[1:]:
            if part in {'.', '..'}:
                raise ValueError('invalid root')
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def ignore_all(fd):
    # Attachments and teleport copies in a project's .cloudroom folder must never reach its Git.
    try:
        file = os.open('.gitignore', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    except OSError:
        return
    with os.fdopen(file, 'w') as output:
        output.write('*\n')


def safe_path(value):
    if not isinstance(value, str) or not value or '\\' in value or '\x00' in value:
        raise ValueError('invalid relative path')
    parts = value.split('/')
    if any(p in {'', '.', '..'} or p in EXCLUDED or p.startswith('.cloudroom-sync-') for p in parts):
        raise ValueError('excluded or invalid relative path')
    return parts


def ignore_all(fd):
    # Git skips Cloudroom's own folder in the project, so agents never commit pasted files.
    try:
        output = os.open('.gitignore', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=fd)
    except OSError:  # Already there, or a read-only folder: never block the upload.
        return
    with os.fdopen(output, 'w') as file:
        file.write('*\n')


def transfer(data, kind, executable, output=None, limit=MAX_FILE_BYTES):
    digest = hashlib.sha256((kind + str(executable)).encode())
    size = 0
    while chunk := data.read(CHUNK):
        size += len(chunk)
        if size > limit:
            raise Conflict('source exceeds the transfer size')
        digest.update(chunk)
        if output is not None:
            output.write(chunk)
    return {'tag': digest.hexdigest(), 'kind': kind, 'executable': executable, 'size': size}


def swap(fd, first, second, second_fd=None):
    # Exchange preserves the displaced inode, including writes through an already-open fd.
    libc = ctypes.CDLL(None, use_errno=True)
    function = getattr(libc, 'renameatx_np' if sys.platform == 'darwin' else 'renameat2')
    if function(fd, os.fsencode(first), fd if second_fd is None else second_fd, os.fsencode(second), 2) != 0:
        raise OSError(ctypes.get_errno(), 'atomic exchange failed')


class Tree:
    def __init__(self, root, kind='skills', filename=None, create=False):
        self.root, self.kind, self.filename = Path(root), kind, filename
        self.create = create

    @contextlib.contextmanager
    def parent(self, relative, create=False):
        parts = safe_path(relative)
        if excluded(relative):
            raise ValueError('file is excluded from sync')
        if self.filename and relative != self.filename:
            raise ValueError('file is outside the selected settings')
        with directory(self.root, self.create) as root:
            fd = os.dup(root)
            try:
                for index, part in enumerate(parts[:-1]):
                    if create:
                        try:
                            os.mkdir(part, mode=0o700, dir_fd=fd)
                        except FileExistsError:
                            pass
                    child = os.open(part, DIRECTORY, dir_fd=fd)
                    os.close(fd)
                    fd = child
                    if create and index == 0 and part == '.cloudroom':
                        ignore_all(fd)
                yield fd, parts[-1]
            finally:
                os.close(fd)

    def attach(self, relative, stream, limit, size):
        with self.parent(relative, create=True) as (fd, name):
            try:
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError('attachment must be a regular file')
                return {'size': info.st_size}
            except FileNotFoundError:
                pass
            temporary = '.attachment-' + uuid.uuid4().hex
            try:
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
                with os.fdopen(os.open(temporary, flags, 0o600, dir_fd=fd), 'wb') as output:
                    entry = transfer(stream, 'file', False, output, limit)
                    if entry['size'] != size:
                        raise ValueError('incomplete attachment')
                    output.flush()
                    os.fsync(output.fileno())
                try:
                    os.link(temporary, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                except FileExistsError:
                    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    if not stat.S_ISREG(info.st_mode):
                        raise ValueError('attachment must be a regular file')
                    return {'size': info.st_size}
                os.fsync(fd)
                return {'size': entry['size']}
            finally:
                try:
                    os.unlink(temporary, dir_fd=fd)
                except FileNotFoundError:
                    pass

    def known_rollout(self, native_id, filename=None):
        # Codex resumes a conversation it already knows only from that saved path.
        # Its dated folders win over teleport/ copies left by earlier failed transfers.
        found = []
        for folder, _, names in os.walk(self.root):
            for name in names:
                if name == filename if filename else name.endswith(f'-{native_id}.jsonl'):
                    relative = os.path.relpath(os.path.join(folder, name), self.root)
                    found.append((not relative.startswith('teleport/'), os.lstat(os.path.join(folder, name)).st_mtime, relative))
        return max(found)[2] if found else None

    def install_transfer(self, request, stream):
        native = request.get('native')
        # A Codex fork reads its parent conversations (lineage) at saved byte offsets, so they stay byte-for-byte.
        lineage = request.get('lineage') and PurePosixPath(request['path']).name
        relative = (native and native['harness'] == 'codex' and self.known_rollout(native['id'], lineage)) or request['path']
        digest = hashlib.sha256()
        count = 0
        with self.parent(relative, create=True) as (fd, name):
            temporary = '.teleport-' + uuid.uuid4().hex
            try:
                out = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
                with os.fdopen(out, 'wb') as output:
                    # Claude and Cursor sessions are stored byte-for-byte; the core checks them.
                    if native and native['harness'] in ('pi', 'codex'):
                        line = stream.readline(16 * 1024 * 1024 + 1)
                        if len(line) > 16 * 1024 * 1024 or not line.endswith(b'\n'):
                            raise ValueError('invalid native header')
                        digest.update(line); count += len(line)
                        header = json.loads(line)
                        metadata = header if native['harness'] == 'pi' else header.get('payload', {})
                        expected = native['id']
                        if lineage:
                            owner = re.fullmatch(r'rollout-[0-9T-]{19}-([0-9a-f-]{36})(_[0-9a-f-]{36})?\.jsonl', lineage)
                            expected = owner and owner[1]
                        if not expected or metadata.get('id') != expected:
                            raise ValueError('native identity mismatch')
                        if native['harness'] == 'pi':
                            if header.get('type') != 'session' or header.get('version') != 3:
                                raise ValueError('unsupported Pi session')
                        elif header.get('type') != 'session_meta':
                            raise ValueError('unsupported Codex session')
                        if lineage:
                            output.write(line)
                        else:
                            metadata['cwd'] = native['cwd']
                            metadata.pop('dynamic_tools', None)
                            output.write((json.dumps(header, separators=(',', ':')) + '\n').encode())
                    while chunk := stream.read(CHUNK):
                        count += len(chunk)
                        if count > request['size']:
                            raise Conflict('upload exceeds manifest size')
                        digest.update(chunk); output.write(chunk)
                    if count != request['size'] or digest.hexdigest() != request['sha256']:
                        raise Conflict('upload checksum mismatch')
                    output.flush(); os.fsync(output.fileno())
                    os.fchmod(output.fileno(), 0o700 if request.get('executable') else 0o600)
                try:
                    os.link(temporary, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                except FileExistsError:
                    def checksum(filename, limit=MAX_FILE_BYTES):
                        with os.fdopen(os.open(filename, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd), 'rb') as existing:
                            if not stat.S_ISREG(os.fstat(existing.fileno()).st_mode):
                                raise ValueError('expected regular transfer file')
                            checksum = hashlib.sha256()
                            while limit and (chunk := existing.read(min(CHUNK, limit))):
                                checksum.update(chunk); limit -= len(chunk)
                            return checksum.digest()
                    # A parent conversation that only grew since already holds every byte its forks read.
                    if lineage and checksum(name, count) == digest.digest():
                        pass
                    elif checksum(name) != checksum(temporary):
                        if not native:
                            raise Conflict('transfer destination changed')
                        # A returning conversation replaces the VM's older copy, which stays beside it.
                        os.link(name, f'{name}.before-teleport-{uuid.uuid4().hex}', src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                        os.replace(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
                os.fsync(fd)
            finally:
                try: os.unlink(temporary, dir_fd=fd)
                except FileNotFoundError: pass
            if native and native['harness'] == 'claude-code':
                # Core refuses a Claude ID found in two project folders, so older copies are set aside.
                with directory(self.root) as root:
                    for folder in os.listdir(root):
                        if folder == relative.split('/')[0]:
                            continue
                        try: other = os.open(folder, DIRECTORY, dir_fd=root)
                        except OSError: continue
                        try: os.rename(name, f'{name}.before-teleport-{uuid.uuid4().hex}', src_dir_fd=other, dst_dir_fd=other)
                        except FileNotFoundError: pass
                        finally: os.close(other)
            project_path = request.get('project_path')
            if project_path:
                # Incoming bytes are durable. A conflicting directory or unwritable
                # checkout must not prevent the agent from using the preserved copy.
                with contextlib.suppress(OSError):
                    with self.parent(project_path, create=True) as (target_fd, target_name):
                        staged = '.teleport-' + uuid.uuid4().hex
                        try:
                            with os.fdopen(os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd), 'rb') as incoming:
                                if request.get('symlink'):
                                    target = incoming.read(os.pathconf(self.root, 'PC_PATH_MAX') + 1).decode()
                                    self.check_link(project_path, target)
                                    os.symlink(target, staged, dir_fd=target_fd)
                                else:
                                    output_fd = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700 if request.get('executable') else 0o600, dir_fd=target_fd)
                                    with os.fdopen(output_fd, 'wb') as output:
                                        shutil.copyfileobj(incoming, output, CHUNK)
                                        output.flush(); os.fsync(output.fileno())
                            try:
                                os.link(staged, target_name, src_dir_fd=target_fd, dst_dir_fd=target_fd, follow_symlinks=False)
                            except FileExistsError:
                                pass
                            os.fsync(target_fd)
                        finally:
                            try: os.unlink(staged, dir_fd=target_fd)
                            except FileNotFoundError: pass
        return {'path': str(self.root / relative)}

    def projected(self, data):
        if self.kind == 'auth':
            if not isinstance(json.loads(data), dict):
                raise ValueError('invalid credential file')
            return data
        if self.kind not in PORTABLE:
            return data
        toml = self.kind in {'codex', 'mcp-toml'}
        if toml and tomllib is None:
            raise ValueError('Codex settings require Python 3.11+')
        value = tomllib.loads(data.decode()) if toml else json.loads(data)
        if not isinstance(value, dict):
            raise ValueError('invalid settings')
        if self.kind in MCP:
            servers = value.get(MCP[self.kind]) or {}
            if not isinstance(servers, dict):
                raise ValueError('invalid MCP servers')
            value = {MCP[self.kind]: {n: s for n, s in servers.items() if portable_mcp(n, s)}}
            if not value[MCP[self.kind]]:
                return b'{}'
        return json.dumps({k: v for k, v in value.items() if k in PORTABLE[self.kind]}, sort_keys=True, separators=(',', ':')).encode()

    def merged_mcp(self, servers, original):
        key = MCP[self.kind]
        if not isinstance(servers, dict) or not all(portable_mcp(n, s) for n, s in servers.items()):
            raise ValueError('unsupported MCP server')
        if self.kind == 'mcp-json':
            document = json.loads(original or b'{}')
            if not isinstance(document, dict) or not isinstance(document.setdefault(key, {}), dict):
                raise ValueError('invalid MCP settings')
            document[key].update(servers)
            return (json.dumps(document, indent=2) + '\n').encode()
        # Replace only the incoming servers' tables; everything else stays byte-for-byte.
        lines, replacing = [], False
        for line in original.decode().splitlines():
            if re.match(r'^\s*\[', line):
                table = re.match(r'^\s*\[\s*mcp_servers\.([A-Za-z0-9_-]+)\s*[.\]]', line)
                replacing = bool(table and table[1] in servers)
            if not replacing:
                lines.append(line)
        tables = [f'[mcp_servers.{name}]\n' + ''.join(f'{k} = {json.dumps(v, ensure_ascii=False)}\n' for k, v in sorted(server.items()))
                  for name, server in sorted(servers.items())]
        result = '\n'.join(lines).rstrip('\n') + ('\n\n' if lines else '') + '\n'.join(tables)
        if any(tomllib.loads(result).get(key, {}).get(n) != s for n, s in servers.items()):
            raise ValueError('unsupported Codex MCP layout')
        return result.encode()

    def merged(self, incoming, original):
        if self.kind not in PORTABLE:
            return self.projected(incoming)
        values = json.loads(incoming)
        if not isinstance(values, dict) or values.keys() - PORTABLE[self.kind]:
            raise ValueError('unsupported settings')
        if self.kind in MCP:
            return self.merged_mcp(values.get(MCP[self.kind], {}), original)
        if any(not isinstance(v, (str, bool, int)) for v in values.values()):
            raise ValueError('unsupported setting value')
        if self.kind == 'codex':
            tomllib.loads(original.decode())
            lines, in_table = [], False
            for line in original.decode().splitlines():
                in_table = in_table or bool(re.match(r'^\s*\[', line))
                key = re.match(r'^\s*([a-z_]+)\s*=', line)
                if in_table or not key or key[1] not in PORTABLE['codex']:
                    lines.append(line)
            prefix = [f'{k} = {json.dumps(v)}' for k, v in sorted(values.items())]
            return ('\n'.join(prefix + lines) + '\n').encode()
        values_before = json.loads(original or b'{}')
        for key in PORTABLE[self.kind]:
            values_before.pop(key, None)
        values_before.update(values)
        return (json.dumps(values_before, indent=2) + '\n').encode()

    def inspect(self, fd, name, relative, output=None, project=True):
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if info.st_size > MAX_FILE_BYTES:
            raise ValueError('file exceeds the project transfer limit')
        if stat.S_ISLNK(info.st_mode):
            if self.filename:
                raise ValueError('settings file must not be a symlink')
            target = os.readlink(name, dir_fd=fd)
            self.check_link(relative, target)
            return transfer(io.BytesIO(target.encode()), 'symlink', False, output)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('unsupported file type')
        with os.fdopen(os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd), 'rb') as data:
            before = self.signature(os.fstat(data.fileno()))
            source = io.BytesIO(self.projected(data.read())) if project and (self.kind in PORTABLE or self.kind == 'auth') else data
            entry = transfer(source, 'file', bool(info.st_mode & 0o111) and not self.filename, output)
            if before != self.signature(os.fstat(data.fileno())):
                raise Conflict('file changed during scan')
            return entry

    @contextlib.contextmanager
    def snapshot(self, relative):
        with self.parent(relative) as (fd, name), tempfile.TemporaryFile() as output:
            entry = self.inspect(fd, name, relative, output)
            output.seek(0)
            yield entry, output

    @staticmethod
    def signature(info):
        return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode]

    def check_link(self, relative, target):
        if not target or Path(target).is_absolute():
            raise ValueError('external symlink')
        # Lexical validation plus no-follow parent opens prevent traversal through other links.
        resolved = os.path.normpath(str(PurePosixPath(relative).parent / target))
        safe_path(resolved)

    def settle(self):
        # Retain the original inode: an idle open writer may still modify it later.
        if not (self.root / PENDING).exists():
            return
        with directory(self.root / PENDING) as fd:
            for name in os.listdir(fd):
                if not re.fullmatch('[a-f0-9]{32}\\.json', name):
                    continue
                with os.fdopen(os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)) as source:
                    saved = json.load(source)
                safe_path(saved['path'])
                backup = name[:-5]
                try:
                    info = os.stat(backup, dir_fd=fd, follow_symlinks=False)
                    if saved.get('incoming_inode') == [info.st_dev, info.st_ino]:
                        continue  # Interrupted before exchange; this is input, not a displaced original.
                    entry = self.inspect(fd, backup, saved['path'], project=False)
                except FileNotFoundError:
                    entry = None
                if entry is not None and entry['tag'] != saved['fingerprint']:
                    raise Conflict('concurrent edit preserved in pending recovery')

    def scan(self, cache=None):
        self.settle()
        files, folded, cache, skipped = {}, {}, cache or {}, []
        def visit(fd, prefix=''):
            for name in sorted(os.listdir(fd)):
                path = prefix + name
                if excluded(path):
                    continue
                if self.filename and path != self.filename:
                    continue
                key = unicodedata.normalize('NFC', path).casefold()
                if key in folded and folded[key] != path:
                    raise Conflict('case-colliding filenames')
                folded[key] = path
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if not self.filename and stat.S_ISLNK(info.st_mode):
                    try:
                        self.check_link(path, os.readlink(name, dir_fd=fd))
                    except ValueError:
                        skipped.append(path)
                        continue
                if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                    skipped.append(path)
                    continue
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(name, DIRECTORY, dir_fd=fd)
                    try:
                        visit(child, path + '/')
                    finally:
                        os.close(child)
                else:
                    signature = self.signature(info)
                    saved = cache.get(path)
                    if saved and saved.get('signature') == signature:
                        files[path] = saved
                    else:
                        files[path] = {**self.inspect(fd, name, path), 'signature': signature}
        with directory(self.root, self.create) as fd:
            visit(fd)
        if self.kind in PORTABLE:
            empty = hashlib.sha256(b'fileFalse{}').hexdigest()
            files = {p: e for p, e in files.items() if e['tag'] != empty}
        return {'files': files, 'skipped': skipped}

    def logical_tag(self, entry):
        if self.kind in PORTABLE and entry['tag'] == hashlib.sha256(b'fileFalse{}').hexdigest():
            return None
        return entry['tag']

    def tag(self, relative):
        try:
            with self.parent(relative) as (fd, name):
                return self.logical_tag(self.inspect(fd, name, relative))
        except FileNotFoundError:
            return None

    def apply(self, relative, expected, entry, stream):
        safe_path(relative)
        if expected is not None and (not isinstance(expected, str) or not re.fullmatch('[a-f0-9]{64}', expected)):
            raise ValueError('invalid baseline')
        if entry is not None:
            if (entry.get('kind') not in {'file', 'symlink'} or type(entry.get('executable')) is not bool
                    or type(entry.get('size')) is not int or not 0 <= entry['size'] <= MAX_FILE_BYTES
                    or not isinstance(entry.get('tag'), str) or not re.fullmatch('[a-f0-9]{64}', entry['tag'])):
                raise ValueError('invalid file metadata')
        if entry is None and self.kind in PORTABLE:
            if expected is None:
                return
            entry = {'kind': 'file', 'executable': False, 'size': 2, 'tag': hashlib.sha256(b'fileFalse{}').hexdigest()}
            stream = io.BytesIO(b'{}')
        with self.parent(relative, create=entry is not None) as (fd, name):
            if any(other != name and unicodedata.normalize('NFC', other).casefold() == unicodedata.normalize('NFC', name).casefold() for other in os.listdir(fd)):
                raise Conflict('case-colliding filenames')
            backup = uuid.uuid4().hex
            temporary = backup
            with directory(self.root / PENDING, create=True) as recovery:
                if self.tag(relative) != expected:
                    raise Conflict('destination changed')
                try:
                    os.stat(name, dir_fd=fd, follow_symlinks=False)
                    exists = True
                except FileNotFoundError:
                    exists = False
                fingerprint = self.inspect(fd, name, relative, project=False)['tag'] if exists else None
                def save_recovery(incoming_inode=None):
                    info = os.open(backup + '.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=recovery)
                    with os.fdopen(info, 'w') as metadata:
                        json.dump({'path': relative, 'fingerprint': fingerprint, 'incoming_inode': incoming_inode}, metadata)
                        metadata.flush(); os.fsync(metadata.fileno())
                if entry is None:
                    if expected is None:
                        return
                    save_recovery()
                    os.fsync(recovery)
                    os.rename(name, backup, src_dir_fd=fd, dst_dir_fd=recovery)
                    os.fsync(fd); os.fsync(recovery)
                    if self.logical_tag(self.inspect(recovery, backup, relative)) != expected:
                        raise Conflict('concurrent edit preserved in recovery')
                    return
                original_signature = None
                preserve_recovery = False
                try:
                    if entry['kind'] == 'symlink':
                        if entry['size'] > os.pathconf(self.root, 'PC_PATH_MAX'):
                            raise ValueError('symlink is too long')
                        target = stream.read(entry['size'] + 1).decode()
                        if len(target.encode()) != entry['size']:
                            raise Conflict('incomplete symlink')
                        self.check_link(relative, target)
                        os.symlink(target, temporary, dir_fd=recovery)
                    elif entry['kind'] == 'file':
                        output_fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=recovery)
                        with os.fdopen(output_fd, 'wb') as output:
                            if self.kind in PORTABLE or self.kind == 'auth':
                                try:
                                    original_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
                                    with os.fdopen(original_fd, 'rb') as original:
                                        original_signature = self.signature(os.fstat(original.fileno()))
                                        previous = original.read()
                                except FileNotFoundError:
                                    previous = b''
                                if entry['size'] > 16 * 1024 * 1024:
                                    raise ValueError('settings exceed the existing API JSON limit')
                                incoming = stream.read(entry['size'] + 1)
                                if len(incoming) != entry['size'] or self.kind in MCP and transfer(io.BytesIO(incoming), 'file', False)['tag'] != entry['tag']:
                                    raise Conflict('incomplete settings')
                                output.write(self.merged(incoming, previous))
                            else:
                                received = transfer(stream, 'file', entry['executable'], output, entry['size'])
                                if received['size'] != entry['size'] or received['tag'] != entry['tag']:
                                    raise Conflict('incomplete or changed transfer')
                            output.flush(); os.fsync(output.fileno())
                            os.fchmod(output.fileno(), 0o600 if self.filename else 0o755 if entry['executable'] else 0o644)
                    else:
                        raise ValueError('unsupported entry')
                    # MCP merges add to existing servers, so the result may hold more than the incoming set.
                    if (self.filename and self.kind not in MCP or entry['kind'] == 'symlink') and self.inspect(recovery, temporary, relative)['tag'] != entry['tag']:
                        raise Conflict('incomplete or changed transfer')
                    if (self.tag(relative) != expected or (original_signature is not None
                            and self.signature(os.stat(name, dir_fd=fd, follow_symlinks=False)) != original_signature)):
                        raise Conflict('destination changed during transfer')
                    if exists:
                        incoming = os.stat(temporary, dir_fd=recovery, follow_symlinks=False)
                        save_recovery([incoming.st_dev, incoming.st_ino])
                    os.fsync(recovery)
                    if not exists:
                        os.link(temporary, name, src_dir_fd=recovery, dst_dir_fd=fd, follow_symlinks=False)
                    else:
                        # Exchange directly into recovery: no fallible move can strand
                        # the displaced original in a temporary-file cleanup path.
                        preserve_recovery = True
                        swap(recovery, temporary, name, fd)
                        os.fsync(recovery)
                    os.fsync(fd)
                    if exists and self.logical_tag(self.inspect(recovery, backup, relative)) != expected:
                        raise Conflict('concurrent edit preserved in recovery')
                finally:
                    if not preserve_recovery:
                        try:
                            os.unlink(temporary, dir_fd=recovery)
                        except FileNotFoundError:
                            pass


def worker():
    request = json.loads(sys.stdin.buffer.readline())
    tree = Tree(**request['tree'])
    op = request['op']
    if op == 'mkdir':
        with directory(tree.root, create=True):
            pass
        result = {}
    elif op == 'open':
        import array
        import socket
        def send_file(fd):
            with socket.socket(fileno=os.dup(1)) as channel:
                channel.sendmsg([b'F'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [fd]))])
        if request.get('directory'):
            parts = safe_path(request['path']) if request['path'] else []
            with directory(tree.root.joinpath(*parts)) as fd:
                send_file(fd)
        else:
            with tree.parent(request['path']) as (fd, name):
                opened = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                with os.fdopen(opened, 'rb') as file:
                    if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
                        raise ValueError('expected a regular file')
                    send_file(file.fileno())
        return
    elif op == 'attach':
        try:
            result = tree.attach(request['path'], sys.stdin.buffer, request['limit'], request['size'])
        except Conflict:
            print(json.dumps({'ok': False, 'error': 'attachment_too_large'}), flush=True)
            return
    elif op == 'teleport':
        result = tree.install_transfer(request, sys.stdin.buffer)
    elif op == 'scan':
        result = tree.scan(request.get('cache'))
    elif op == 'read':
        with tree.snapshot(request['path']) as (entry, data):
            if entry['tag'] != request['expected']:
                raise Conflict('source changed')
            print(json.dumps({'ok': True, **entry}), flush=True)
            shutil.copyfileobj(data, sys.stdout.buffer, CHUNK)
        return
    elif op == 'cursor_key':
        if tree.filename != 'cloudroom-api-key' or not isinstance(request['key'], str):
            raise ValueError('invalid Cursor key destination')
        data = request['key'].encode()
        if not data or len(data) > 4096 or any(byte < 33 or byte > 126 for byte in data):
            raise ValueError('invalid Cursor key')
        try:
            with tree.snapshot(tree.filename) as (previous, _):
                expected = previous['tag']
        except FileNotFoundError:
            expected = None
        tree.apply(tree.filename, expected, transfer(io.BytesIO(data), 'file', False), io.BytesIO(data))
        result = {}
    elif op == 'import_auth':
        data = json.dumps(request['credentials'], separators=(',', ':')).encode()
        entry = transfer(io.BytesIO(data), 'file', False)
        try:
            tree.apply('auth.json', None, entry, io.BytesIO(data))
        except (Conflict, FileExistsError):
            pass  # An existing login always wins, including a concurrent native sign-in.
        result = {}
    elif op == 'pi_auth':
        # Pi keeps one entry per provider. Imports only add missing providers; `replace` is an explicit user key.
        if tree.filename != 'auth.json' or not isinstance(request['credentials'], dict):
            raise ValueError('invalid Pi login request')
        try:
            with tree.snapshot('auth.json') as (previous, data):
                expected, current = previous['tag'], json.load(data)
        except FileNotFoundError:
            expected, current = None, {}
        if not isinstance(current, dict):
            raise ValueError('invalid Pi login file')
        added = [name for name in request['credentials'] if request.get('replace') or name not in current]
        if added:
            data = json.dumps({**current, **{name: request['credentials'][name] for name in added}}, indent=2).encode()
            tree.apply('auth.json', expected, transfer(io.BytesIO(data), 'file', False), io.BytesIO(data))
        result = {'providers': sorted({*current, *added}), 'added': added}
    elif op == 'pi_setup':
        # The Mac's custom providers replace same-named VM providers; VM-only providers stay.
        if tree.filename != 'models.json' or not isinstance(request['providers'], dict):
            raise ValueError('invalid Pi setup request')
        try:
            with tree.snapshot('models.json') as (previous, data):
                expected, current = previous['tag'], json.load(data)
        except FileNotFoundError:
            expected, current = None, {}
        if not isinstance(current, dict) or not isinstance(current.get('providers', {}), dict):
            raise ValueError('invalid Pi models file')
        providers = {**current.get('providers', {}), **request['providers']}
        if providers != current.get('providers', {}):
            data = json.dumps({**current, 'providers': providers}, indent=2).encode()
            tree.apply('models.json', expected, transfer(io.BytesIO(data), 'file', False), io.BytesIO(data))
        try:
            with Tree(tree.root, 'auth', 'settings.json').snapshot('settings.json') as (_, data):
                packages = json.load(data).get('packages', [])
        except FileNotFoundError:
            packages = []
        result = {'providers': sorted(providers), 'packages': packages if isinstance(packages, list) else []}
    elif op == 'pi_packages':
        # `pi install` saves only a package's source; the Mac's entry also keeps its resource filters.
        if tree.filename != 'settings.json' or not isinstance(request['packages'], list):
            raise ValueError('invalid Pi packages request')
        mac = {entry['source']: entry for entry in request['packages'] if isinstance(entry, dict) and isinstance(entry.get('source'), str)}
        try:
            with tree.snapshot('settings.json') as (previous, data):
                expected, current = previous['tag'], json.load(data)
        except FileNotFoundError:
            expected, current = None, {}
        if not isinstance(current, dict) or not isinstance(current.get('packages', []), list):
            raise ValueError('invalid Pi settings file')
        source = lambda entry: entry if isinstance(entry, str) else entry.get('source') if isinstance(entry, dict) else None
        packages = [mac.get(source(entry), entry) for entry in current.get('packages', [])]
        if packages != current.get('packages', []):
            data = json.dumps({**current, 'packages': packages}, indent=2).encode()
            tree.apply('settings.json', expected, transfer(io.BytesIO(data), 'file', False), io.BytesIO(data))
        result = {}
    elif op == 'apply':
        tree.apply(request['path'], request['expected'], request.get('entry'), sys.stdin.buffer)
        result = {}
    else:
        raise ValueError('unknown operation')
    print(json.dumps({'ok': True, **result}), flush=True)


if __name__ == '__main__':
    try:
        worker()
    except Conflict:
        print(json.dumps({'ok': False, 'error': 'conflict'}), flush=True)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'ok': False, 'error': 'files_unavailable', 'errno': getattr(error, 'errno', None)}), flush=True)
