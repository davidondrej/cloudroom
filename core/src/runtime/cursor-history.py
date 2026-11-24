"""Restore a teleported Cursor chat (meta.json plus its SQLite store) from one snapshot's JSONL."""
import base64
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import uuid


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
        if sys.argv[1] == 'restore':
            restore(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
        else:
            raise ValueError('unsupported operation')
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as error:
        print(f'Cursor native history unavailable: {type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(1)
