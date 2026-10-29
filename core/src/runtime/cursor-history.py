"""Capture Cursor's per-session SQLite store without copying a live WAL database."""
import base64
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import signal
import stat
import sys
import tempfile
import time
import uuid

CHUNK = 64 * 1024


def session_directory(root, session_id):
    if str(uuid.UUID(session_id)) != session_id:
        raise ValueError('invalid Cursor session ID')
    path = Path(root) / session_id
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        os.fchdir(fd)
    finally:
        os.close(fd)
    return path


def regular(name):
    info = os.stat(name, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode):
        raise ValueError('Cursor history must be a regular file')
    return info


def capture(root, session_id):
    def timed_out(*_):
        raise TimeoutError('Cursor snapshot exceeded the normal 30-second RPC budget')
    signal.signal(signal.SIGALRM, timed_out)
    signal.alarm(30)
    directory = session_directory(root, session_id)
    regular('meta.json')
    # Cursor rewrites meta.json in place (truncate, then write). Retry a torn read.
    for attempt in range(20):
        meta = Path('meta.json').read_bytes()
        try:
            metadata = json.loads(meta)
            break
        except ValueError:
            if attempt == 19:
                raise
            time.sleep(0.05)
    if metadata.get('schemaVersion') != 1 or not isinstance(metadata.get('cwd'), str):
        raise ValueError('unsupported Cursor metadata')
    snapshot = str(uuid.uuid4())
    index = 0
    digest = hashlib.sha256()

    def emit(value, complete=False):
        nonlocal index
        line = json.dumps(value, separators=(',', ':'))
        print(json.dumps({'snapshot': snapshot, 'index': index, 'complete': complete, 'record': line}), flush=True)
        digest.update(line.encode() + b'\n')
        index += 1

    with tempfile.TemporaryDirectory(prefix='.cloudroom-snapshot-', dir=directory) as temporary:
        # Emit the bytes validated above, not a second read that can be torn.
        (Path(temporary) / 'meta.json').write_bytes(meta)
        files = [('meta.json', Path(temporary) / 'meta.json')]
        if Path('store.db').exists():
            regular('store.db')
            for name in ['store.db-wal', 'store.db-shm']:
                if Path(name).exists():
                    regular(name)
            target = Path(temporary) / 'store.db'
            # WAL sidecars may need recreating after Cursor exits. query_only forbids data writes.
            with sqlite3.connect((directory / 'store.db').as_uri() + '?mode=rw', uri=True, timeout=4) as source:
                source.execute('PRAGMA query_only=ON')
                source.execute('PRAGMA trusted_schema=OFF')
                with sqlite3.connect(target) as destination:
                    source.backup(destination, pages=256, progress=lambda *_: None)
                    if destination.execute('PRAGMA quick_check').fetchone() != ('ok',):
                        raise ValueError('invalid Cursor database')
            files.append(('store.db', target))
        emit({'type': 'cursor_snapshot', 'version': 1, 'session_id': session_id})
        for name, path in files:
            with path.open('rb') as source:
                offset = 0
                while chunk := source.read(CHUNK):
                    emit({'file': name, 'offset': offset, 'data': base64.b64encode(chunk).decode()})
                    offset += len(chunk)
        emit({'end': True, 'sha256': digest.hexdigest()}, complete=True)
    signal.alarm(0)


def restore(root, cwd=None):
    """Read one complete native snapshot as JSONL; never overwrite an existing session."""
    if cwd:
        # Print-mode Cursor finds chats under chats/<md5 of the working folder>.
        root = Path(root) / hashlib.md5(cwd.encode()).hexdigest()
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root = Path(root).resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='.cloudroom-restore-', dir=root) as temporary:
        target = Path(temporary)
        digest = hashlib.sha256()
        session_id = None
        completed = False
        for raw in sys.stdin:
            if completed:
                raise ValueError('multiple snapshots supplied')
            value = json.loads(raw)
            if value.get('end'):
                if value.get('sha256') != digest.hexdigest():
                    raise ValueError('incomplete or damaged snapshot')
                completed = True
                continue
            digest.update(raw.rstrip('\n').encode() + b'\n')
            if value.get('type') == 'cursor_snapshot':
                if session_id is not None or value.get('version') != 1:
                    raise ValueError('unsupported snapshot')
                session_id = str(uuid.UUID(value['session_id']))
                if session_id != value['session_id']:
                    raise ValueError('invalid session ID')
                continue
            name = value.get('file')
            if session_id is None or name not in {'meta.json', 'store.db'}:
                raise ValueError('invalid snapshot file')
            path = target / name
            size = path.stat().st_size if path.exists() else 0
            if value.get('offset') != size:
                raise ValueError('snapshot offset mismatch')
            with path.open('ab') as output:
                output.write(base64.b64decode(value['data'], validate=True))
                output.flush()
                os.fsync(output.fileno())
        if not completed or session_id is None:
            raise ValueError('incomplete snapshot')
        metadata = json.loads((target / 'meta.json').read_text())
        if metadata.get('schemaVersion') != 1:
            raise ValueError('unsupported metadata')
        if cwd:
            metadata['cwd'] = cwd
            (target / 'meta.json').write_text(json.dumps(metadata))
        if (target / 'store.db').exists():
            with sqlite3.connect(f'file:{target / "store.db"}?mode=ro', uri=True) as database:
                database.execute('PRAGMA trusted_schema=OFF')
                if database.execute('PRAGMA quick_check').fetchone() != ('ok',):
                    raise ValueError('invalid restored database')
        destination = root / session_id
        if (destination / 'meta.json').exists():
            print(json.dumps({'session_id': session_id, 'path': str(destination)}))
            return
        # mkdir is exclusive; no existing conversation is ever replaced.
        destination.mkdir(mode=0o700)
        for path in target.iterdir():
            os.chmod(path, 0o600)
            os.rename(path, destination / path.name)
        for path in [destination, root]:
            fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        print(json.dumps({'session_id': session_id, 'path': str(destination)}))


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'capture':
            capture(sys.argv[2], sys.argv[3])
        elif sys.argv[1] == 'restore':
            restore(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
        else:
            raise ValueError('unsupported operation')
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as error:
        print(f'Cursor native history unavailable: {type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(1)
