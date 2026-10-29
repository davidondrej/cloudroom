#!/usr/bin/env python3
"""Installer contract checks using a temporary directory, never host configuration."""
import importlib.util
import errno
import json
import os
from pathlib import Path
import tempfile
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('installer', Path(__file__).resolve().parents[1] / 'install/configure.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='cloudroom-installer-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.directory = self.root / 'config'
        self.data = dict(userId='self-hosted-é', coreToken='safe-token-' * 4,
                         databaseUrl='postgresql://ordinary_user:ordinary%40password@localhost/history', release='test')
        self.calls = []
        environment = patch.dict(os.environ)
        environment.start(); self.addCleanup(environment.stop)
        os.environ.pop('CLOUDROOM_LISTEN', None)
        os.environ.pop('CLOUDROOM_ALLOW_NON_LOOPBACK_HTTP', None)
        for name, path in [('CODE_ROOT', self.root / 'code'), ('CACHE_ROOT', self.root / 'cache'),
                           ('installed_version', lambda: 'test')]:
            setting = patch.object(installer, name, path)
            setting.start(); self.addCleanup(setting.stop)
        for target, value in [
            ('os.geteuid', lambda: 0), ('os.chown', lambda *args: None), ('os.fchown', lambda *args: None),
            ('os.getgrouplist', lambda name, gid: [gid]),
            ('pwd.getpwnam', lambda name: SimpleNamespace(pw_uid=1001 if name == 'cloudroom-agent' else 1000,
                                                        pw_gid=1001 if name == 'cloudroom-agent' else 1000,
                                                        pw_dir=str(self.root / name))),
            ('subprocess.run', lambda args, **kwargs: self.calls.append(args)),
        ]:
            p = patch(target, value); p.start(); self.addCleanup(p.stop)

    def test_self_hosted_credentials_and_stable_retries(self):
        installer.configure(self.data, self.directory)
        path = self.directory / 'core.env'
        original = path.read_bytes()
        values = dict(line.split('=', 1) for line in path.read_text().splitlines())
        self.assertEqual(json.loads(values['CLOUDROOM_STORE']), self.data['userId'])
        self.assertEqual(json.loads(values['CLOUDROOM_DATABASE_URL']), self.data['databaseUrl'])
        self.assertEqual(json.loads(values['CLOUDROOM_LISTEN']), '127.0.0.1:9840')
        self.assertNotIn('CLOUDROOM_ALLOW_NON_LOOPBACK_HTTP', values)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o750)
        self.assertEqual((self.root / 'code').stat().st_mode & 0o777, 0o700)
        policy = self.directory / 'storage.json'
        saved = policy.read_bytes()
        installer.configure(self.data, self.directory)
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(policy.read_bytes(), saved)
        self.assertEqual(self.calls, [['systemctl', 'enable', '--now', 'cloudroom.service']] * 2)
        with self.assertRaisesRegex(ValueError, 'differs'):
            installer.configure({**self.data, 'databaseUrl': self.data['databaseUrl'] + '2'}, self.directory)
        self.assertEqual(path.read_bytes(), original)

    def test_explicit_listener_and_existing_bindings_survive_retries(self):
        with patch.dict(os.environ, CLOUDROOM_LISTEN='0.0.0.0:9840'):
            installer.configure(self.data, self.directory)
        path = self.directory / 'core.env'
        original = path.read_bytes()
        values = dict(line.split('=', 1) for line in path.read_text().splitlines())
        self.assertEqual(json.loads(values['CLOUDROOM_LISTEN']), '0.0.0.0:9840')
        self.assertNotIn('CLOUDROOM_ALLOW_NON_LOOPBACK_HTTP', values)
        for listen in [None, '127.0.0.1:9840']:
            with patch.dict(os.environ, CLOUDROOM_ALLOW_NON_LOOPBACK_HTTP='1'):
                if listen is not None:
                    os.environ['CLOUDROOM_LISTEN'] = listen
                installer.configure(self.data, self.directory)
            self.assertEqual(path.read_bytes(), original)
        self.assertEqual(self.calls, [['systemctl', 'enable', '--now', 'cloudroom.service']] * 3)

    def test_http_permission_is_saved_only_when_explicit_and_survives_retries(self):
        for index, permission in enumerate(['', '0', 'true', '01', ' 1 ', '1']):
            directory = self.root / f'permission-{index}'
            with self.subTest(permission=permission):
                with patch.dict(os.environ, CLOUDROOM_LISTEN='0.0.0.0:9840',
                                CLOUDROOM_ALLOW_NON_LOOPBACK_HTTP=permission):
                    installer.configure(self.data, directory)
                path = directory / 'core.env'
                original = path.read_bytes()
                values = dict(line.split('=', 1) for line in path.read_text().splitlines())
                self.assertEqual(values.get('CLOUDROOM_ALLOW_NON_LOOPBACK_HTTP'),
                                 json.dumps('1') if permission == '1' else None)
                installer.configure(self.data, directory)
                self.assertEqual(path.read_bytes(), original)

    def test_invalid_input_never_writes_configuration(self):
        for field, value in [('userId', ''), ('coreToken', 'weak'), ('coreToken', 'x' * 32 + ' '),
                             ('databaseUrl', 'https://localhost/history'), ('databaseUrl', 'postgres://localhost:bad/db'),
                             ('databaseUrl', 'postgres://localhost/db#fragment'), ('release', 'other'),
                             ('userId', 'bad\nCLOUDROOM_TOKEN=bad')]:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                installer.configure({**self.data, field: value}, self.directory)
            self.assertFalse(self.directory.exists())
        self.assertEqual(self.calls, [])

    def test_configuration_symlink_is_rejected(self):
        target = self.root / 'target'; target.mkdir()
        self.directory.symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'symlinks'):
            installer.configure(self.data, self.directory)
        self.assertEqual(list(target.iterdir()), [])

    def test_unsafe_accounts_are_rejected_before_writing(self):
        lookup = installer.pwd.getpwnam
        for name, field, value in [('cloudroom-agent', 'pw_uid', 0), ('cloudroom', 'pw_uid', 0),
                                   ('cloudroom-agent', 'pw_uid', 1000), ('cloudroom-agent', 'pw_gid', 0),
                                   ('cloudroom-agent', 'pw_gid', 1000)]:
            def account(requested):
                result = lookup(requested)
                if requested == name:
                    setattr(result, field, value)
                return result
            with self.subTest(name=name, field=field, value=value), patch('pwd.getpwnam', account):
                with self.assertRaisesRegex(ValueError, 'Separate unprivileged'):
                    installer.configure(self.data, self.directory)
            self.assertFalse(self.directory.exists())
        with patch('os.geteuid', return_value=1001), self.assertRaisesRegex(ValueError, 'administrator'):
            installer.configure(self.data, self.directory)
        with patch('os.getgrouplist', return_value=[1001, 0]), self.assertRaisesRegex(ValueError, 'primary group'):
            installer.configure(self.data, self.directory)
        self.assertFalse(self.directory.exists())
        self.assertEqual(self.calls, [])

    def test_disk_policy_without_quotas_and_retries_preserve_settings(self):
        service, agent = installer.accounts()
        installer.setup_storage(self.directory, service, agent)
        policy = self.directory / 'storage.json'
        self.assertEqual(json.loads(policy.read_text()), {
            'agent_uid': 1001, 'agent_gid': 1001, 'cache_dir': str(self.root / 'cache'),
            'cgroup_root': '/sys/fs/cgroup/system.slice/cloudroom.service/agents',
        })
        self.assertEqual(policy.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.root / 'cache').stat().st_mode & 0o777, 0o700)
        saved = {**json.loads(policy.read_text()), 'warning_bytes': 6_000_000_000}
        policy.write_text(json.dumps(saved))
        before = policy.read_bytes()
        installer.setup_storage(self.directory, service, agent)
        self.assertEqual(policy.read_bytes(), before)
        self.assertEqual(self.calls, [])
        outside = self.root / 'outside'; outside.write_text('keep')
        policy.unlink(); policy.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'symlinks'):
            installer.setup_storage(self.directory, service, agent)
        self.assertEqual(outside.read_text(), 'keep')


class AgentHomeTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('agent_home', Path(__file__).resolve().parents[1] / 'install/agent-home.py')
        self.setup = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.setup)
        temporary = tempfile.TemporaryDirectory(prefix='cloudroom-agent-home-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.shell = SimpleNamespace(pw_name='operator', pw_uid=2001, pw_gid=2001, pw_dir=str(self.root / 'shell'))
        self.agent = SimpleNamespace(pw_name='cloudroom-agent', pw_uid=2002, pw_gid=2002, pw_dir=str(self.root / 'agent'))
        self.archive = self.root / 'archive'
        for home in (Path(self.shell.pw_dir), Path(self.agent.pw_dir)):
            for relative in ('.codex', '.pi/agent', '.local/bin'):
                (home / relative).mkdir(parents=True, exist_ok=True)
            for relative in ('.codex/auth.json', '.pi/agent/auth.json'):
                (home / relative).write_text(home.name + '-synthetic-login')
        for name in ('os.chown', 'os.fchown', 'os.setgroups', 'os.setegid', 'os.seteuid'):
            p = patch(name); p.start(); self.addCleanup(p.stop)
        p = patch.object(self.setup, 'shell_agents', return_value=[])
        self.processes = p.start(); self.addCleanup(p.stop)
        # Restore directory write bits so TemporaryDirectory can clean up on non-root hosts.
        self.addCleanup(lambda: [p.chmod(0o700) for p in self.root.rglob('*') if p.is_dir()])

    def test_retirement_preserves_history_conflicts_and_core_logins(self):
        shell, agent = Path(self.shell.pw_dir), Path(self.agent.pw_dir)
        (shell / '.codex/sessions').mkdir()
        (shell / '.codex/sessions/keep.jsonl').write_text('original conversation')
        (shell / '.codex/config.toml').write_text('model = "old"')
        (agent / '.codex/config.toml').write_text('model = "current"')
        (shell / '.pi/agent/AGENTS.md').write_text('shared instructions')
        (shell / '.local/bin/codex').write_text('old launcher')
        (shell / '.pi/agent/skills').symlink_to(self.root / 'outside')
        before = {p: p.read_bytes() for p in agent.rglob('*') if p.is_file()}
        preview = self.setup.retire(self.shell, self.agent, self.archive)
        self.assertEqual(preview['status'], 'ready')
        self.assertTrue((shell / '.codex/auth.json').exists())
        report = self.setup.retire(self.shell, self.agent, self.archive, apply=True)
        saved = self.archive / self.shell.pw_name
        self.assertEqual(report['conflicts'], 1)
        self.assertEqual(report['preserved_symlinks'], 1)
        self.assertEqual(report['copied_settings'], 1)
        self.assertEqual((saved / '.codex/sessions/keep.jsonl').read_text(), 'original conversation')
        self.assertEqual((saved / '.codex/auth.json').read_text(), 'shell-synthetic-login')
        self.assertEqual((saved / 'codex-launcher').read_text(), 'old launcher')
        self.assertEqual((agent / '.pi/agent/AGENTS.md').read_text(), 'shared instructions')
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)
        for tool in ('codex', 'pi'):
            result = subprocess.run([str(shell / '.local/bin' / tool), 'login'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 126)
            self.assertIn('Standalone cloud agents are disabled', result.stderr)
        self.setup.check(self.shell, self.agent)
        again = self.setup.retire(self.shell, self.agent, self.archive, apply=True)
        self.assertEqual(again['copied_settings'], 0)
        self.assertEqual((saved / 'codex-launcher').read_text(), 'old launcher')
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)

    def test_snapshot_safe_archive_preserves_files_and_symlinks(self):
        source = self.root / 'source'
        source.mkdir()
        (source / 'history').write_text('keep all history')
        (source / 'link').symlink_to('history')
        saved = self.root / 'saved'
        with patch.object(Path, 'rename', side_effect=OSError(errno.EXDEV, 'cross mount')) as rename:
            self.setup.archive_move(source, saved)
            rename.assert_not_called()
        self.assertFalse(source.exists())
        self.assertEqual((saved / 'history').read_text(), 'keep all history')
        self.assertEqual(os.readlink(saved / 'link'), 'history')
        broken = self.root / 'broken'; broken.mkdir()
        (broken / 'original').write_text('preserve on failure')
        with patch.object(Path, 'rename', side_effect=OSError(errno.EXDEV, 'cross mount')), \
             patch.object(self.setup.shutil, 'copy2', side_effect=OSError('copy failed')):
            with self.assertRaises(self.setup.shutil.Error):
                self.setup.archive_move(broken, self.root / 'partial')
        self.assertEqual((broken / 'original').read_text(), 'preserve on failure')

    def test_running_shell_agent_and_symlink_abort_without_moving_data(self):
        self.processes.return_value = [123]
        with self.assertRaisesRegex(ValueError, 'still running'):
            self.setup.retire(self.shell, self.agent, self.archive, apply=True)
        self.assertFalse(self.archive.exists())
        self.processes.return_value = []
        path = Path(self.agent.pw_dir) / '.codex'
        path.rename(path.with_name('saved-codex'))
        path.symlink_to(path.with_name('saved-codex'))
        with self.assertRaisesRegex(ValueError, 'symlinks'):
            self.setup.retire(self.shell, self.agent, self.archive, apply=True)
        self.assertFalse(self.archive.exists())

    def test_recreated_credentials_fail_check_without_deleting_them(self):
        self.setup.retire(self.shell, self.agent, self.archive, apply=True)
        path = Path(self.shell.pw_dir) / '.codex'
        path.chmod(0o755)
        auth = path / 'auth.json'
        auth.write_text('unexpected-injected-login')
        with self.assertRaisesRegex(ValueError, 'competing'):
            self.setup.check(self.shell, self.agent)
        self.assertEqual(auth.read_text(), 'unexpected-injected-login')
        report = self.setup.retire(self.shell, self.agent, self.archive, apply=True)
        self.assertEqual((Path(report['archive']) / '.codex/auth.json').read_text(), 'unexpected-injected-login')
        self.assertEqual((self.archive / 'operator/.codex/auth.json').read_text(), 'shell-synthetic-login')
        self.assertFalse(auth.exists())
        self.setup.check(self.shell, self.agent)


if __name__ == '__main__':
    unittest.main()
