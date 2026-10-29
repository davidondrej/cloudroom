#!/usr/bin/env python3
"""Install forwarding-only SSH access. Run as the VM operator; never prints private keys."""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import tempfile


def atomic(path, text, mode=0o600, uid=0, gid=0):
    if path.is_symlink():
        raise ValueError('Refusing symlink: ' + str(path))
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.preview-')
    try:
        with os.fdopen(fd, 'w') as file:
            file.write(text); file.flush(); os.fsync(file.fileno())
        os.chown(name, uid, gid); os.chmod(name, mode)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def configure(state, binary, reload=True):
    if os.geteuid() != 0:
        raise ValueError('Run as the provisioning administrator')
    if not all(re.fullmatch(r'/[a-zA-Z0-9_./-]+', str(p)) for p in (state, binary)):
        raise ValueError('Use absolute installation paths without shell characters')
    service, agent = (pwd.getpwnam(name) for name in ('cloudroom', 'cloudroom-agent'))
    for path in (state, binary):
        for parent in (path, *path.parents):
            info = parent.lstat()
            if parent.is_symlink() or info.st_uid == agent.pw_uid or info.st_mode & 0o022:
                raise ValueError('Installation paths must be protected from agent writes')
    try:
        preview = pwd.getpwnam('cloudroom-preview')
    except KeyError:
        subprocess.run(['useradd', '--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', '--password', '*', 'cloudroom-preview'], check=True)
        preview = pwd.getpwnam('cloudroom-preview')
    if preview.pw_uid in (0, service.pw_uid, agent.pw_uid) or os.getgrouplist(preview.pw_name, preview.pw_gid) != [preview.pw_gid]:
        raise ValueError('Preview account must be separate and unprivileged')
    directory = state / 'previews'
    if directory.is_symlink():
        raise ValueError('Invalid preview state directory')
    directory.mkdir(mode=0o700, exist_ok=True)
    os.chown(directory, service.pw_uid, service.pw_gid); directory.chmod(0o700)
    setup_path = directory / 'setup.json'
    setup = json.loads(setup_path.read_text()) if setup_path.exists() else {'host': None, 'port': 22}
    setup.update(socket='/run/cloudroom/preview.sock', host_key_file='/etc/ssh/ssh_host_ed25519_key.pub', agent_uid=agent.pw_uid)
    atomic(setup_path, json.dumps(setup), uid=service.pw_uid, gid=service.pw_gid)
    runtime = Path('/run/cloudroom')
    if runtime.is_symlink():
        raise ValueError('Invalid preview socket directory')
    runtime.mkdir(mode=0o711, exist_ok=True)
    os.chown(runtime, service.pw_uid, service.pw_gid); runtime.chmod(0o711)
    # OpenSSH requires root-owned command ancestors; providers may give their operator /usr/local/lib.
    lookup = Path('/etc/ssh/cloudroom-preview-keys')
    for parent in (lookup.parent, *lookup.parent.parents):
        info = parent.lstat()
        if parent.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('SSH command directory must be root-owned and protected')
    previous_lookup = lookup.read_text() if lookup.exists() else None
    atomic(lookup, f'#!/bin/sh\nexec {binary} --preview-authorized-keys {directory}/registry.json {agent.pw_uid} "$1"\n', mode=0o755)
    config = Path('/etc/ssh/sshd_config.d/60-cloudroom-preview.conf')
    text = '''Match User cloudroom-preview
    AuthorizedKeysFile none
    AuthorizedKeysCommand /etc/ssh/cloudroom-preview-keys %u
    AuthorizedKeysCommandUser cloudroom
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding local
    AllowStreamLocalForwarding no
    PermitOpen 127.0.0.1:*
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    PermitTunnel no
    MaxSessions 0
Match all
'''
    if config.is_symlink():
        raise ValueError('Invalid SSH configuration path')
    previous = config.read_text() if config.exists() else None
    atomic(config, text, mode=0o644)
    try:
        subprocess.run(['/usr/sbin/sshd', '-t'], check=True, capture_output=True)
        if reload:
            result = subprocess.run(['systemctl', 'reload', 'ssh.service'], capture_output=True)
            if result.returncode:
                subprocess.run(['systemctl', 'reload', 'sshd.service'], check=True, capture_output=True)
    except subprocess.SubprocessError:
        if previous is None:
            config.unlink()
        else:
            atomic(config, previous, mode=0o644)
        if previous_lookup is None:
            lookup.unlink()
        else:
            atomic(lookup, previous_lookup, mode=0o755)
        raise ValueError('SSH validation/reload failed; previous configuration restored') from None
    # Mac access (ADR 0113) and secret requests share the preview pairing's agent socket, so their skills install here too.
    for name, flag in [('cloud-preview', '--preview-skill'), ('cloud-mac', '--mac-skill'), ('cloud-secrets', '--secrets-skill'), ('room-cli', '--room-cli-skill')]:
        skill = subprocess.check_output([str(binary), flag], text=True)
        for base in ['.agents', '.codex', '.pi/agent', '.claude']:
            command = ['sudo', '-u', agent.pw_name, 'python3', '-c',
                       'import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.mkdir(parents=True,exist_ok=True); f=p/"SKILL.md"; data=sys.stdin.read(); f.write_text(data) if not f.exists() else None',
                       str(Path(agent.pw_dir) / base / 'skills' / name)]
            subprocess.run(command, input=skill, text=True, check=True)
    # `room-cli` is the agent CLI's name (ADR 0240); `cloudroom` is the old one.
    for link in [Path('/usr/local/bin/cloudroom'), Path('/usr/local/bin/room-cli')]:
        if not link.exists() and not link.is_symlink():
            link.symlink_to(binary)
    print('Preview SSH access configured. The desktop supplies its own public key through the core API.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('state', type=Path)
    parser.add_argument('--binary', type=Path, default=Path('/usr/local/lib/cloudroom/cloudroom'))
    parser.add_argument('--no-reload', action='store_true', help='Only for an isolated SSH test server that will be started separately')
    args = parser.parse_args()
    configure(args.state.resolve(), args.binary.resolve(), not args.no_reload)
