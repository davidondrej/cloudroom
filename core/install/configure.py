#!/usr/bin/env python3
"""Configure a preinstalled core from private JSON on stdin. Never log that JSON."""
import json
import os
from pathlib import Path
import pwd
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

CODE_ROOT = Path('/code')
CACHE_ROOT = Path('/var/cache/cloudroom-agent')


def accounts():
    if os.geteuid() != 0:
        raise ValueError('Run as the provisioning administrator')
    service, agent = (pwd.getpwnam(name) for name in ('cloudroom', 'cloudroom-agent'))
    if (0 in (service.pw_uid, service.pw_gid, agent.pw_uid, agent.pw_gid)
            or service.pw_uid == agent.pw_uid or service.pw_gid == agent.pw_gid):
        raise ValueError('Separate unprivileged service and agent accounts are required')
    if os.getgrouplist('cloudroom-agent', agent.pw_gid) != [agent.pw_gid]:
        raise ValueError('Agent must have only its own primary group')
    return service, agent


def setup_storage(directory, service, agent):
    policy = directory / 'storage.json'
    if not directory.is_absolute() or directory.is_symlink() or policy.is_symlink() or CACHE_ROOT.is_symlink():
        raise ValueError('Storage configuration paths must be absolute and not symlinks')
    directory.mkdir(mode=0o750, exist_ok=True)
    os.chown(directory, 0, service.pw_gid)
    directory.chmod(0o750)
    CACHE_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chown(CACHE_ROOT, agent.pw_uid, agent.pw_gid)
    CACHE_ROOT.chmod(0o700)
    if not policy.exists():
        with os.fdopen(os.open(policy, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'w') as file:
            json.dump({'agent_uid': agent.pw_uid, 'agent_gid': agent.pw_gid,
                       'cache_dir': str(CACHE_ROOT), 'cgroup_root': '/sys/fs/cgroup/system.slice/cloudroom.service/agents'}, file)
            file.flush(); os.fsync(file.fileno())
            os.fchown(file.fileno(), service.pw_uid, service.pw_gid)


def installed_version():
    # The binary is the only version source (ADR 0120); output is "cloudroom VERSION (COMMIT)".
    output = subprocess.run(['/usr/local/lib/cloudroom/cloudroom', '--version'], capture_output=True, text=True, check=True).stdout
    return output.split()[1]


def configure(data, directory=Path('/etc/cloudroom')):
    if os.geteuid() != 0:
        raise ValueError('Run as the provisioning administrator')
    # apiUrl (ADR 0232) is where a new Core saves history; older setup requests don't send it.
    if not isinstance(data, dict) or set(data) - {'apiUrl'} != {'userId', 'coreToken', 'databaseUrl', 'release'}:
        raise ValueError('Unexpected setup fields')
    api = data.get('apiUrl')
    if api is not None and (not isinstance(api, str) or not api.startswith('https://') or api.endswith('/')
                            or any(ord(c) <= 32 or ord(c) == 127 or c in '?#@' for c in api)):
        raise ValueError('apiUrl must be an https:// URL without a trailing slash')
    owner, token, database, release = (data[k] for k in ('userId', 'coreToken', 'databaseUrl', 'release'))
    if not all(isinstance(v, str) for v in (owner, token, database, release)):
        raise ValueError('Setup fields must be strings')
    if any(any(ord(c) < 32 or ord(c) == 127 for c in value) for value in (owner, token, database, release)):
        raise ValueError('Invalid configuration value')
    if not owner.strip() or len(token) < 32 or not all(33 <= ord(c) < 127 for c in token):
        raise ValueError('A store name and a strong core token are required')
    connection = urlsplit(database)
    if (connection.scheme not in ('postgres', 'postgresql') or connection.fragment
            or not (connection.hostname or connection.path)):
        raise ValueError('A PostgreSQL connection URL is required')
    _ = connection.port  # Reject malformed ports before writing protected configuration.
    if installed_version() != release:
        raise ValueError('The requested release does not match this template')
    service, agent = accounts()
    path = directory / 'core.env'
    if not directory.is_absolute() or directory.is_symlink() or path.is_symlink():
        raise ValueError('Configuration paths must not be symlinks')
    directory.mkdir(mode=0o750, exist_ok=True)
    os.chown(directory, 0, service.pw_gid)
    directory.chmod(0o750)
    # Reruns never replace settings, rotate credentials, or restart existing workloads.
    if path.exists():
        previous = dict(line.split('=', 1) for line in path.read_text().splitlines() if '=' in line)
        if any(previous.get(k) != json.dumps(v, ensure_ascii=False) for k, v in {
            'CLOUDROOM_STORE': owner, 'CLOUDROOM_TOKEN': token, 'CLOUDROOM_DATABASE_URL': database
        }.items()):
            raise ValueError('Existing configuration differs; no changes made')
    else:
        settings = {
            'CLOUDROOM_STORE': owner, 'CLOUDROOM_TOKEN': token, 'CLOUDROOM_DATABASE_URL': database,
            'CLOUDROOM_LISTEN': os.environ.get('CLOUDROOM_LISTEN', '127.0.0.1:9840'), 'CLOUDROOM_ACCOUNT_HOME': agent.pw_dir,
            'CLOUDROOM_STATE_DIR': str(Path(service.pw_dir) / 'history'),
            'CLOUDROOM_STORAGE_POLICY': str(directory / 'storage.json'),
            **({'CLOUDROOM_API_URL': api} if api else {}),
        }
        if os.environ.get('CLOUDROOM_ALLOW_NON_LOOPBACK_HTTP') == '1':
            settings['CLOUDROOM_ALLOW_NON_LOOPBACK_HTTP'] = '1'
        if any(any(ord(c) < 32 or ord(c) == 127 for c in v) for v in settings.values()):
            raise ValueError('Invalid configuration value')
        fd, temp = tempfile.mkstemp(dir=directory, prefix='.core-')
        try:
            with os.fdopen(fd, 'w') as f:
                f.write(''.join(k + '=' + json.dumps(v, ensure_ascii=False) + '\n' for k, v in settings.items()))
                f.flush(); os.fsync(f.fileno())
            os.chown(temp, service.pw_uid, service.pw_gid)
            os.replace(temp, path)
        finally:
            Path(temp).unlink(missing_ok=True)
    workspaces = CODE_ROOT
    if workspaces.is_symlink():
        raise ValueError('/code must be a real directory')
    workspaces.mkdir(mode=0o700, exist_ok=True)
    os.chown(workspaces, agent.pw_uid, agent.pw_gid)
    workspaces.chmod(0o700)
    setup_storage(directory, service, agent)
    subprocess.run(['systemctl', 'enable', '--now', 'cloudroom.service'], check=True)
    print('Core installed. Agent setup is still required.')


if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--storage-only':
            setup_storage(Path(sys.argv[2]), *accounts())
            print('Disk policy configured. No quotas or filesystem settings changed.')
        else:
            raw = sys.stdin.buffer.read(16385)
            if len(raw) > 16384:
                raise ValueError('Setup input is too large')
            if len(sys.argv) > 2:
                raise ValueError('Use configure.py [protected-configuration-directory]')
            configure(json.loads(raw), Path(sys.argv[1]) if len(sys.argv) == 2 else Path('/etc/cloudroom'))
    except (ValueError, OSError, KeyError, subprocess.SubprocessError):
        # Native exceptions may include the database password; keep provider logs generic.
        print('Core configuration failed. Inspect protected configuration and service status.', file=sys.stderr)
        sys.exit(1)
