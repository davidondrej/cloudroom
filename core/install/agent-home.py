#!/usr/bin/env python3
"""Retire a managed VM's administrator-owned Codex/Pi setup without touching core logins."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import tempfile
import uuid

MARKER = 'CLOUDROOM_ONLY'
BLOCKED = '''#!/bin/sh
printf '%s\n' 'Standalone cloud agents are disabled. Start a Cloud thread in Cloudroom or use its core API.' >&2
exit 126
'''
# Native histories, credentials and unknown configuration stay in the private archive.
SETTINGS = ('.codex/AGENTS.md', '.codex/config.toml', '.codex/hooks.json', '.codex/skills',
            '.pi/agent/AGENTS.md', '.pi/agent/settings.json', '.pi/agent/models.json',
            '.pi/agent/skills', '.pi/agent/extensions')


def real_path(path):
    if not path.is_absolute() or any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('Setup paths must be absolute and must not traverse symlinks')


def atomic_file(path, content, mode):
    fd, name = tempfile.mkstemp(prefix='.cloudroom-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.chown(name, 0, 0)
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def archive_move(source, destination):
    # Copy, verify, then remove. A sandbox restore lost files inside a renamed directory;
    # newly written archive files also work when /home and /srv are separate mounts.
    def copy_verified(source_file, destination_file):
        shutil.copy2(source_file, destination_file)
        with open(source_file, 'rb') as original, open(destination_file, 'rb') as saved:
            if hashlib.file_digest(original, 'sha256').digest() != hashlib.file_digest(saved, 'sha256').digest():
                raise ValueError('File changed while archiving; originals retained')
        return destination_file
    if source.is_symlink():
        destination.symlink_to(os.readlink(source))
        source.unlink()
    elif source.is_dir():
        shutil.copytree(source, destination, symlinks=True, copy_function=copy_verified)
        shutil.rmtree(source)
    else:
        copy_verified(source, destination)
        source.unlink()


def shell_agents(uid):
    found = []
    for process in Path('/proc').glob('[0-9]*'):
        try:
            if process.stat().st_uid != uid:
                continue
            arguments = (process / 'cmdline').read_bytes().split(b'\0')
            executable = Path(os.fsdecode(arguments[0])).name
            command = (process / 'comm').read_text().strip()
            if (command in ('codex', 'pi') or executable in ('codex', 'pi')
                    or any(b'/@openai/codex/' in arg or b'/pi-coding-agent/' in arg
                           for arg in arguments[:3])):
                found.append(int(process.name))
        except (FileNotFoundError, ProcessLookupError):
            continue
    return found


@contextlib.contextmanager
def as_agent(agent):
    """Write in the agent's home as the agent. Root's chown would follow a symlink the agent swaps in mid-copy."""
    euid, egid, groups = os.geteuid(), os.getegid(), os.getgroups()
    os.setgroups([agent.pw_gid])
    os.setegid(agent.pw_gid)
    os.seteuid(agent.pw_uid)
    try:
        yield
    finally:
        os.seteuid(euid)
        os.setegid(egid)
        os.setgroups(groups)


def copy_missing(source, destination, agent, report):
    if source.is_symlink():
        report['preserved_symlinks'] += 1
    elif source.is_dir():
        with as_agent(agent):
            if destination.exists() and not destination.is_dir() or destination.is_symlink():
                report['conflicts'] += 1
                return
            destination.mkdir(mode=0o700, parents=True, exist_ok=True)
        for child in source.iterdir():
            copy_missing(child, destination / child.name, agent, report)
    elif source.is_file():
        content = source.read_bytes()
        with as_agent(agent):
            if destination.exists() or destination.is_symlink():
                if destination.is_symlink() or not destination.is_file() or content != destination.read_bytes():
                    report['conflicts'] += 1
                return
            real_path(destination)
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            # Exclusive creation never replaces settings written concurrently by an agent.
            with os.fdopen(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as output:
                output.write(content)
        report['copied_settings'] += 1


def retire(shell, agent, archive_root, apply=False):
    home, target = Path(shell.pw_dir), Path(agent.pw_dir)
    archive = archive_root / shell.pw_name
    if 0 in (shell.pw_uid, agent.pw_uid) or shell.pw_uid == agent.pw_uid or home == target:
        raise ValueError('Use distinct non-root administrator and agent accounts')
    for path in (home, target, archive, home / '.local/bin', target / '.codex', target / '.pi/agent'):
        real_path(path)
    roots = [home / '.codex', home / '.pi']
    for path in roots:
        real_path(path)
        if path.exists() and not path.is_dir():
            raise ValueError('An agent configuration path is not a directory')
        if (archive / path.name).exists() and path.exists() and not marked(path):
            raise ValueError('Archive and active setup both exist; review before proceeding')
    reinjected = any((archive / path.name).exists() and path.exists() and not retired(path) for path in roots)
    data_archive = archive / 'reinjected' / uuid.uuid4().hex if reinjected else archive
    active = shell_agents(shell.pw_uid)
    if active:
        raise ValueError('Shell-owned agents are still running; leave them untouched and retry after they exit')
    report = {'archive': str(data_archive), 'copied_settings': 0, 'conflicts': 0, 'preserved_symlinks': 0}
    if not apply:
        return {**report, 'status': 'ready' if not all(retired(path) for path in roots) else 'retired'}
    archive.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chown(archive_root, 0, 0)
    archive_root.chmod(0o700)
    os.chown(archive, 0, 0)
    archive.chmod(0o700)
    data_archive.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Block ordinary shell entrypoints before moving credentials out of their lookup paths.
    bin_dir = home / '.local/bin'
    bin_dir.mkdir(mode=0o755, parents=True, exist_ok=True)
    for tool in ('codex', 'pi'):
        path = bin_dir / tool
        saved = archive / (tool + '-launcher')
        if (path.exists() or path.is_symlink()) and not (saved.exists() or saved.is_symlink()):
            archive_move(path, saved)
        atomic_file(path, BLOCKED.encode(), 0o755)
    with as_agent(agent):
        for relative in ('.codex', '.pi', '.pi/agent'):
            path = target / relative
            if not path.exists():
                path.mkdir(mode=0o700)
    for relative in SETTINGS:
        copy_missing(home / relative, target / relative, agent, report)
    if shell_agents(shell.pw_uid):
        raise ValueError('A shell agent started during preparation; no configuration was moved')
    for path in roots:
        if retired(path):
            continue
        if path.exists():
            archive_move(path, data_archive / path.name)
        path.mkdir(mode=0o755)
        atomic_file(path / MARKER, b'Agent setup moved to Cloudroom. Use the core API.\n', 0o444)
        os.chown(path, 0, 0)
        path.chmod(0o555)
    check(shell, agent)
    return {**report, 'status': 'retired'}


def marked(path):
    marker = path / MARKER
    return (path.is_dir() and not path.is_symlink()
            and marker.is_file() and not marker.is_symlink() and marker.stat().st_uid == os.geteuid())


def retired(path):
    return (marked(path) and path.stat().st_uid == os.geteuid()
            and not path.stat().st_mode & 0o222 and {p.name for p in path.iterdir()} == {MARKER})


def check(shell, agent):
    for relative in ('.codex', '.pi'):
        path = Path(shell.pw_dir) / relative
        real_path(path)
        if not retired(path):
            raise ValueError('A competing shell agent setup exists; repair it before starting Cloudroom')
    for tool in ('codex', 'pi'):
        path = Path(shell.pw_dir) / '.local/bin' / tool
        real_path(path)
        if not path.is_file() or path.read_text() != BLOCKED or path.stat().st_uid != os.geteuid():
            raise ValueError('Standalone shell agent launcher is not disabled')
    for relative in ('.codex', '.pi/agent'):
        real_path(Path(agent.pw_dir) / relative)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--shell-user', required=True)
    parser.add_argument('--archive', type=Path, default=Path('/srv/cloudroom/retired-shell'))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError('Run as the provisioning administrator')
    shell, agent = pwd.getpwnam(args.shell_user), pwd.getpwnam('cloudroom-agent')
    with open('/run/cloudroom-agent-home.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.check:
            check(shell, agent)
            print('One active agent setup verified')
        else:
            print(json.dumps(retire(shell, agent, args.archive, args.apply)))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError) as error:
        # Filenames may be sensitive; never print config, credentials or exception payloads.
        print(str(error) if isinstance(error, ValueError) else 'Agent setup failed: ' + type(error).__name__ + ' (errno ' + str(getattr(error, 'errno', None)) + ')')
        raise SystemExit(1)
