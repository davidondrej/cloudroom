"""Disposable Linux E2E: agent CLI, exact socket ownership, real SSH, and live revocation.
Requires the existing OpenSSH server/client, curl, setpriv and a built core. Never run on a customer VM.
"""
import argparse
import contextlib
import hashlib
import http.client
import json
import os
from pathlib import Path
import pwd
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

# CI points this at the optimized build it ships (ADR 0296).
BINARY = Path(os.environ.get('CLOUDROOM_BIN') or Path(__file__).resolve().parents[1] / 'target/debug/cloudroom')


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE, timeout=20, **kwargs).strip()


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def until(check):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (OSError, ValueError, http.client.HTTPException):
            pass
        time.sleep(.1)
    raise AssertionError('Preview check did not become ready')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--disposable', action='store_true', required=True)
    parser.parse_args()
    assert os.geteuid() == 0 and Path('/proc/net/tcp').exists(), 'Disposable Linux root required'
    for name in ('cloudroom', 'cloudroom-agent', 'cloudroom-preview'):
        try:
            pwd.getpwnam(name)
        except KeyError:
            continue
        raise AssertionError('Refusing a machine with existing Cloudroom accounts')
    config = Path('/etc/ssh/sshd_config.d/60-cloudroom-preview.conf')
    lookup = Path('/etc/ssh/cloudroom-preview-keys')
    assert not config.exists() and not lookup.exists() and not Path('/run/cloudroom').exists()
    source = Path(__file__).resolve().parents[1]
    root = Path(tempfile.mkdtemp(prefix='cloudroom-preview-test-', dir='/var/lib'))
    root.chmod(0o755)
    children, accounts, passed = [], [], False
    log = (root / 'processes.log').open('w')

    def start(*args):
        child = subprocess.Popen(args, stdout=log, stderr=log, start_new_session=True)
        children.append(child)
        return child

    try:
        for name in ('cloudroom', 'cloudroom-agent'):
            home = root / name
            run('useradd', '--system', '--user-group', '--no-create-home', '--home-dir', str(home), name)
            accounts.append(name)
            user = pwd.getpwnam(name)
            home.mkdir(mode=0o700); os.chown(home, user.pw_uid, user.pw_gid)
        service, agent = (pwd.getpwnam(name) for name in accounts)
        state = Path(service.pw_dir) / 'history'
        state.mkdir(mode=0o700); os.chown(state, service.pw_uid, service.pw_gid)
        (root / 'bin').mkdir(mode=0o755)
        binary = root / 'bin/cloudroom'
        shutil.copyfile(BINARY, binary); binary.chmod(0o755)
        assert 1000 not in (service.pw_uid, agent.pw_uid)
        os.chown(binary.parent, 1000, 0)  # Reproduce provider-owned /usr/local/lib without changing it.
        Path('/run/sshd').mkdir(exist_ok=True)
        accounts.append('cloudroom-preview')
        run('python3', str(source / 'install/previews.py'), str(state), '--binary', str(binary), '--no-reload')
        host = root / 'host'
        run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(host))
        host.with_suffix('.pub').chmod(0o644)
        core_port, ssh_port, app_port, admin_port = (free_port() for _ in range(4))
        setup = state / 'previews/setup.json'
        data = json.loads(setup.read_text()); data.update(host='127.0.0.1', port=ssh_port, host_key_file=str(host.with_suffix('.pub')))
        setup.write_text(json.dumps(data))
        ssh_config = root / 'sshd.conf'
        ssh_config.write_text(f'Port {ssh_port}\nListenAddress 127.0.0.1\nHostKey {host}\nPidFile {root}/sshd.pid\nUsePAM no\nInclude {config}\n')
        Path('/run/sshd').mkdir(exist_ok=True)
        start('/usr/sbin/sshd', '-D', '-e', '-f', str(ssh_config))
        token = hashlib.sha256(os.urandom(32)).hexdigest()
        env = {'CLOUDROOM_TOKEN': token, 'CLOUDROOM_LISTEN': f'127.0.0.1:{core_port}', 'CLOUDROOM_STATE_DIR': str(state),
               'CLOUDROOM_ACCOUNT_HOME': agent.pw_dir, 'CLOUDROOM_LOCAL_HISTORY': '1',
               'CLOUDROOM_STORE': 'preview-test', 'CLOUDROOM_UNPROTECTED_TEST_MODE': '1'}
        start('setpriv', '--reuid=cloudroom', '--regid=cloudroom', '--init-groups', '--inh-caps=+kill', '--ambient-caps=+kill',
              'env', *[k+'='+v for k,v in env.items()], str(binary))

        def api(path, body=None, method=None):
            req = urllib.request.Request(f'http://127.0.0.1:{core_port}/v1/previews'+path, method=method,
                data=json.dumps(body).encode() if body is not None else None,
                headers={'Authorization': 'Bearer '+token, 'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=5) as response:
                return json.load(response)

        until(lambda: api(''))
        home = Path(agent.pw_dir); (home / 'index.html').write_text('preview-ssh-ok'); os.chown(home / 'index.html', agent.pw_uid, agent.pw_gid)
        app = start('runuser', '-u', 'cloudroom-agent', '--', 'python3', '-m', 'http.server', str(app_port), '--bind', '127.0.0.1', '--directory', str(home))
        start('python3', '-m', 'http.server', str(admin_port), '--bind', '127.0.0.1', '--directory', str(root))
        start('runuser', '-u', 'cloudroom-agent', '--', 'python3', '-m', 'http.server', str(admin_port), '--bind', '127.0.0.2', '--directory', str(home))
        def listening(host, port):
            with socket.create_connection((host, port), timeout=1):
                return True
        until(lambda: listening('127.0.0.2', admin_port))
        until(lambda: listening('127.0.0.1', app_port))
        denied = subprocess.run(['runuser', '-u', 'cloudroom-agent', '--', str(binary), 'preview', str(admin_port)], capture_output=True, text=True)
        assert denied.returncode != 0 and 'agent account' in denied.stderr, 'Wrong-address listener authorized an admin endpoint'
        # Exercise registration through the actual agent-only socket without the CLI's readiness wait.
        accepted = json.loads(run('runuser', '-u', 'cloudroom-agent', '--', 'curl', '-sf', '--unix-socket', '/run/cloudroom/preview.sock',
            '-H', 'Content-Type: application/json', '-d', json.dumps({'port': app_port}), 'http://localhost/previews'))
        assert accepted['state'] == 'pending'
        denied = subprocess.run([str(binary), 'preview', 'status'], capture_output=True, text=True)
        assert denied.returncode != 0 and 'Only the VM agent account' in denied.stderr
        identity = root / 'device'
        run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(identity))
        device = 'a'*32
        metadata = api('/device', {'device': device, 'public_key': ' '.join(identity.with_suffix('.pub').read_text().split()[:2])})
        known = root / 'known_hosts'; known.write_text('cloudroom-preview '+metadata['host_key']+'\n')
        options = ['ssh', '-F', '/dev/null', '-i', str(identity), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
                   '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlias=cloudroom-preview', '-o', 'UserKnownHostsFile='+str(known), '-p', str(ssh_port)]
        for operation in [['cloudroom-preview@127.0.0.1', 'id'], ['-W', f'127.0.0.1:{core_port}', 'cloudroom-preview@127.0.0.1'],
                          ['-N', '-o', 'ExitOnForwardFailure=yes', '-R', f'0:127.0.0.1:{app_port}', 'cloudroom-preview@127.0.0.1']]:
            attempt = subprocess.run(options+operation, capture_output=True, text=True, timeout=10)
            assert attempt.returncode != 0 and 'Permission denied (publickey)' not in attempt.stderr, 'Must authenticate then reject forbidden operation'
        forward = free_port()
        ssh = start(*options, '-N', '-L', f'127.0.0.1:{forward}:127.0.0.1:{app_port}', 'cloudroom-preview@127.0.0.1')

        def get():
            with contextlib.closing(http.client.HTTPConnection('127.0.0.1', forward, timeout=2)) as c:
                c.request('GET', '/'); response = c.getresponse()
                return response.status == 200 and response.read() == b'preview-ssh-ok'

        until(get)
        assert api('/device/'+device, method='DELETE')['revoked']
        ssh.wait(timeout=5)
        try:
            assert not get()
        except (OSError, http.client.HTTPException):
            pass
        assert app.poll() is None, 'Revocation killed the development server'
        assert api('/'+str(app_port), method='DELETE')['state'] == 'closed'
        passed = True
        print('PASS: agent CLI, exact destination ownership, SSH restrictions, active revocation, server preservation')
    except BaseException:
        print('Preview E2E failed; private diagnostics:', root)
        raise
    finally:
        for child in reversed(children):
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL); child.wait()
        log.close()
        config.unlink(missing_ok=True)
        lookup.unlink(missing_ok=True)
        for name in reversed(accounts):
            subprocess.run(['userdel', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree('/run/cloudroom', ignore_errors=True)
        link = Path('/usr/local/bin/cloudroom')
        if link.is_symlink() and link.resolve() == root / 'bin/cloudroom':
            link.unlink()
        if passed:
            shutil.rmtree(root)


if __name__ == '__main__':
    main()
