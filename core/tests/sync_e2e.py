#!/usr/bin/env python3
"""Real HTTP sync checks for skills/settings/login, including safe repository-sync retirement."""
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import core_fixture
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/sync'))
from client import cycle, Remote, configure
from files import Tree, Conflict, atomic_json


class SyncTests(unittest.TestCase):
    setUp, tearDown, start = core_fixture.ReplayTests.setUp, core_fixture.ReplayTests.tearDown, core_fixture.ReplayTests.start

    def prepare(self):
        self.root = self.root.resolve()
        self.local = self.root / 'local'; self.local.mkdir()
        self.cloud = Path(self.env['CLOUDROOM_ACCOUNT_HOME']).resolve() / '.agents/skills'; self.cloud.mkdir(parents=True)
        self.client_state = self.root / 'client'; self.client_state.mkdir()
        self.config = {'device': 'mac', 'roots': [{'id': 'skills-shared', 'tree': {'root': str(self.local), 'kind': 'skills'}}]}
        self.start()
        self.connection = {'url': 'http://' + self.service.address, 'token': self.env['CLOUDROOM_TOKEN']}
        self.remote = Remote(self.connection, 'mac')

    def sync(self):
        return cycle(self.config, self.connection, self.client_state)

    def test_external_skill_link_does_not_block_other_skills_or_delete_old_copy(self):
        self.prepare()
        for name in ['good', 'linked']:
            (self.local / name).mkdir()
            (self.local / name / 'SKILL.md').write_text('original')
        self.assertEqual(self.sync()['state'], 'synced')
        outside = self.root / 'outside'; outside.mkdir()
        (outside / 'secret').write_text('must stay outside')
        (self.local / 'linked/SKILL.md').unlink(); (self.local / 'linked').rmdir()
        (self.local / 'linked').symlink_to(outside)
        (self.local / 'good/SKILL.md').write_text('updated')
        result = self.sync()
        self.assertEqual(result['roots']['skills-shared'], {'state': 'conflict', 'conflicts': 1})
        self.assertEqual((self.cloud / 'good/SKILL.md').read_text(), 'updated')
        self.assertEqual((self.cloud / 'linked/SKILL.md').read_text(), 'original')
        self.assertFalse((self.cloud / 'linked/secret').exists())
        self.assertTrue((self.local / 'linked').is_symlink())
        self.assertEqual(self.sync()['roots']['skills-shared']['conflicts'], 1)

    def test_old_repository_roots_never_copy_or_delete_files_and_migrate_without_losing_baselines(self):
        self.prepare()
        repo = self.root / 'project'; repo.mkdir()
        (repo / 'local-work').write_text('keep uncommitted work')
        (repo / '.env').write_text('SYNTHETIC=not-selected-for-transfer')
        with (repo / 'large').open('wb') as file: file.truncate(5 * 1024**3)
        self.config['roots'].append({'id':'project', 'tree':{'root':str(repo), 'kind':'repo'}})
        self.config['aliases'] = [{'id':'nested','parent':'project','directory':'child','name':'child'}]
        atomic_json(self.client_state / 'project.json', {'base':{'local-work':Tree(repo).tag('local-work')}, 'cache':{}, 'conflicts':[]})
        baseline = (self.client_state / 'project.json').read_bytes()
        self.assertEqual(self.sync()['state'], 'synced')
        self.assertEqual((repo / 'local-work').read_text(), 'keep uncommitted work')
        self.assertFalse(list(self.client_state.glob('.copy-*')))
        self.service.request('GET', '/v1/workspaces/project', expected=404)
        self.service.request('POST', '/v1/sync', {'device':'mac','repositories':['project']}, 410)
        for method in ['GET','PUT']:
            self.service.request(method, '/v1/sync/project/file?device=mac&path=local-work', {} if method=='PUT' else None, 410)
        self.assertEqual((repo / 'local-work').read_text(), 'keep uncommitted work')
        connection_file = self.client_state / 'connection.json'
        atomic_json(connection_file, self.connection)
        self.config.update(connectionFile=str(connection_file), binding=[self.connection['url'], None])
        atomic_json(self.client_state / 'config.json', self.config)
        # An empty home keeps the developer's own MCP configuration out of this migration check.
        with patch('client.launch') as launch, patch('client.Path.home', return_value=self.root.resolve()):
            configure(self.client_state, connection_file)
            self.assertEqual(launch.call_args_list[0].kwargs, {'stop': True})
            self.assertEqual(launch.call_count, 2)
        migrated = json.loads((self.client_state / 'config.json').read_text())
        self.assertEqual([r['id'] for r in migrated['roots']], ['skills-shared'])
        self.assertNotIn('aliases', migrated)
        self.assertEqual((self.client_state / 'project.json').read_bytes(), baseline)
        self.assertEqual((repo / '.env').read_text(), 'SYNTHETIC=not-selected-for-transfer')
        self.assertEqual((repo / 'large').stat().st_size, 5 * 1024**3)

    def test_two_way_edits_deletes_restarts_and_conflicts(self):
        self.prepare()
        (self.local / 'file').write_text('laptop')
        (self.local / 'node_modules').mkdir(); (self.local / 'node_modules/cache').write_text('skip')
        self.assertEqual(self.sync()['state'], 'synced')
        self.assertEqual((self.cloud / 'file').read_text(), 'laptop')
        self.assertFalse((self.cloud / 'node_modules').exists())
        (self.cloud / 'file').write_text('agent')
        self.assertEqual(self.sync()['state'], 'synced')
        self.assertEqual((self.local / 'file').read_text(), 'agent')
        (self.local / 'file').write_text('mac conflict')
        (self.cloud / 'file').write_text('vm conflict')
        self.assertEqual(self.sync()['state'], 'conflict')
        self.assertEqual((self.local / 'file').read_text(), 'mac conflict')
        self.assertEqual((self.cloud / 'file').read_text(), 'vm conflict')
        (self.local / 'file').write_text('resolved'); (self.cloud / 'file').write_text('resolved')
        self.sync()
        (self.cloud / 'file').unlink(); self.sync()
        self.assertFalse((self.local / 'file').exists())
        self.service.stop()
        (self.local / 'offline').write_text('offline work')
        with self.assertRaises(OSError): self.sync()
        self.start(); self.connection['url'] = 'http://' + self.service.address
        self.sync()
        self.assertEqual((self.cloud / 'offline').read_text(), 'offline work')

    def test_lost_ack_and_disappeared_root_do_not_delete_work(self):
        self.prepare()
        (self.local / 'file').write_text('base'); self.sync()
        tree = Tree(self.local)
        (self.local / 'file').write_text('new')
        baseline = json.loads((self.client_state / 'skills-shared.json').read_text())['base']['file']
        with tree.snapshot('file') as (entry, data):
            self.remote.upload('skills-shared', 'file', baseline, entry, data)
        self.sync()
        self.assertEqual((self.local / 'file').read_text(), 'new')
        self.local.rename(self.root / 'moved')
        self.assertEqual(self.sync()['state'], 'offline')
        self.assertEqual((self.cloud / 'file').read_text(), 'new')

    def test_missing_cloud_root_stays_offline_across_restart_and_legacy_upgrade(self):
        self.prepare()
        self.cloud.rmdir()  # First use may initialize a new cloud root.
        (self.local/'file').write_text('keep local work')
        self.assertEqual(self.sync()['state'],'synced')
        self.assertEqual((self.cloud/'file').read_text(),'keep local work')
        for legacy in [False, True]:
            with self.subTest(legacy=legacy):
                self.service.stop()
                if legacy:
                    path=self.state/'sync.json'; value=json.loads(path.read_text())
                    value.pop('initialized_roots'); path.write_text(json.dumps(value))
                moved=self.root/'moved-cloud'; self.cloud.rename(moved)
                self.start(); self.connection['url']='http://'+self.service.address
                for _ in range(2): self.assertEqual(self.sync()['state'],'offline')
                self.assertFalse(self.cloud.exists())
                self.assertEqual((self.local/'file').read_text(),'keep local work')
                moved.rename(self.cloud)
                self.assertEqual(self.sync()['state'],'synced')
        (self.cloud/'file').unlink()
        self.assertEqual(self.sync()['state'],'synced')
        self.assertFalse((self.local/'file').exists(), 'ordinary file deletions must still sync')

    def test_authentication_device_and_path_boundaries(self):
        self.prepare(); self.sync()
        view = self.service.request('GET', '/v1/settings')
        self.assertTrue(view['autoSync']); self.assertFalse(view['repositorySync'])
        self.service.request('PUT', '/v1/settings', {'revision': view['revision'], 'repositories': []}, 405)
        self.service.request('POST', '/v1/sync', {'device':'another-mac'}, 409)
        self.service.request('GET', '/v1/sync/skills-shared?device=mac', expected=401, token=None)
        self.service.request('GET', '/v1/sync/skills-shared?device=wrong', expected=409)
        for path in ['../outside', '/absolute', '.git/config', '.cloudroom-sync-recovery/old']:
            with self.assertRaises(OSError):
                self.remote.upload('skills-shared', path, None, {'tag':'x','kind':'file','executable':False,'size':1}, io.BytesIO(b'x'))
        outside = self.root / 'outside'; outside.mkdir()
        (self.cloud / 'escape').symlink_to(outside)
        with self.assertRaises(OSError):
            self.remote.upload('skills-shared','escape/file',None,{'tag':'x','kind':'file','executable':False,'size':1},io.BytesIO(b'x'))
        self.assertFalse((outside / 'file').exists())

    def test_settings_sync_without_copying_codex_logins_and_old_workers_are_denied(self):
        self.prepare()
        local = self.root / 'settings'; local.mkdir()
        cloud_home = Path(self.env['CLOUDROOM_ACCOUNT_HOME'])
        (cloud_home / '.pi/agent').mkdir(parents=True)
        (local / 'settings.json').write_text(json.dumps({'defaultThinkingLevel':'high','skills':['/mac/only']}))
        (cloud_home / '.pi/agent/settings.json').write_text(json.dumps({'skills':['/linux/only']}))
        (local / 'auth.json').write_text('{"account":"synthetic-mac"}')
        self.config['roots'] = [
            {'id':'settings-pi','tree':{'root':str(local),'kind':'pi','filename':'settings.json'}},
            {'id':'auth-codex','tree':{'root':str(local),'kind':'auth','filename':'auth.json'}},
        ]
        self.assertEqual(self.sync()['state'], 'synced')
        remote_settings = cloud_home / '.pi/agent/settings.json'
        remote_settings.write_text(json.dumps({**json.loads(remote_settings.read_text()),'skills':['/linux/only']}))
        (local / 'settings.json').write_text(json.dumps({'defaultThinkingLevel':'low','skills':['/mac/only']}))
        self.sync()
        self.assertEqual(json.loads(remote_settings.read_text())['skills'], ['/linux/only'])
        self.assertEqual(json.loads(remote_settings.read_text())['defaultThinkingLevel'], 'low')
        remote_auth = cloud_home / '.codex/auth.json'
        remote_auth.write_text('{"account":"synthetic-cloud"}')
        self.sync()
        self.assertEqual((local / 'auth.json').read_text(), '{"account":"synthetic-mac"}')
        self.assertEqual(remote_auth.read_text(), '{"account":"synthetic-cloud"}')
        self.service.request('GET', '/v1/sync/auth-codex?device=' + self.config['device'], expected=410)
        with self.assertRaises(OSError):
            self.remote.upload('auth-codex', 'auth.json', None, {'tag':'x','kind':'file','executable':False,'size':1}, io.BytesIO(b'x'))
        self.assertEqual(remote_auth.read_text(), '{"account":"synthetic-cloud"}')

    def test_pending_recovery_requires_manual_cleanup_and_preserves_late_writers(self):
        self.prepare()
        (self.local / 'file').write_text('base'); self.sync()
        legacy = self.cloud / '.cloudroom-sync-recovery'
        legacy.mkdir(); (legacy / 'previous-work').write_text('keep existing recovery')
        (self.local / 'file').write_text('updated'); self.sync()
        pending = self.cloud / '.cloudroom-sync-pending'
        retained = set(pending.iterdir())
        self.assertTrue(retained)
        self.sync()
        self.assertEqual(set(pending.iterdir()), retained)
        self.assertEqual((legacy / 'previous-work').read_text(), 'keep existing recovery')
        with (self.cloud / 'file').open('r+') as writer:
            (self.local / 'file').write_text('next update'); self.sync()
            self.sync()  # An idle writer must remain recoverable across later scans.
            writer.seek(0); writer.write('late concurrent edit'); writer.truncate(); writer.flush()
        self.assertEqual(self.sync()['state'], 'conflict')
        saved = [p for p in pending.iterdir() if p.suffix != '.json']
        self.assertEqual(sorted(p.read_text() for p in saved), ['base', 'late concurrent edit'])
        self.assertEqual((self.cloud / 'file').read_text(), 'next update')

    def test_pending_settings_preserve_late_machine_specific_changes(self):
        self.prepare()
        name = 'settings.json'
        tree = Tree(self.cloud, 'pi', name)
        (self.cloud / name).write_text('{"defaultThinkingLevel":"low","skills":["old"]}')
        (self.local / name).write_text('{"defaultThinkingLevel":"high"}')
        expected = tree.tag(name)
        with (self.cloud / name).open('r+') as writer:
            with Tree(self.local, 'pi', name).snapshot(name) as (entry, data): tree.apply(name, expected, entry, data)
            writer.seek(0); writer.write('{"defaultThinkingLevel":"low","skills":["new"]}'); writer.truncate(); writer.flush()
        with self.assertRaises(Conflict): tree.scan()
        backups = [p for p in (self.cloud / '.cloudroom-sync-pending').iterdir() if p.suffix != '.json']
        self.assertEqual(json.loads(backups[0].read_text())['skills'], ['new'])

    def test_failed_recovery_move_keeps_concurrent_edits(self):
        import errno
        import files
        self.prepare()
        (self.local / 'file').write_text('original'); self.sync()
        (self.cloud / 'file').write_text('incoming')
        original_swap, original_rename = files.swap, files.os.rename
        def failed_move(source, destination, **kwargs):
            if str(source).startswith('.cloudroom-sync-'):
                raise OSError(errno.ENOSPC, 'synthetic recovery move failure')
            return original_rename(source, destination, **kwargs)
        with (self.local / 'file').open('r+') as writer:
            def concurrent_edit(*args):
                original_swap(*args)
                writer.seek(0); writer.write('concurrent work must survive'); writer.truncate(); writer.flush()
            with patch('files.swap', side_effect=concurrent_edit), patch('files.os.rename', side_effect=failed_move):
                self.sync()
        contents = [p.read_bytes() for p in self.local.rglob('*') if p.is_file()]
        self.assertIn(b'concurrent work must survive', contents, 'sync destroyed the displaced original')
        self.assertEqual((self.local / 'file').read_text(), 'incoming')

    def test_failure_after_exchange_keeps_the_original_in_recovery(self):
        import errno
        import files
        self.prepare()
        (self.local / 'file').write_text('original')
        (self.cloud / 'file').write_text('incoming')
        tree = Tree(self.local)
        expected = tree.tag('file')
        original_swap, original_fsync = files.swap, files.os.fsync
        exchanged = False
        def exchange(*args):
            nonlocal exchanged
            original_swap(*args)
            exchanged = True
        def failed_sync(fd):
            if exchanged: raise OSError(errno.EIO, 'synthetic post-exchange disk failure')
            original_fsync(fd)
        with Tree(self.cloud).snapshot('file') as (entry, data):
            with patch('files.swap', side_effect=exchange), patch('files.os.fsync', side_effect=failed_sync):
                with self.assertRaises(OSError): tree.apply('file', expected, entry, data)
        backups = [p.read_bytes() for p in (self.local / '.cloudroom-sync-pending').iterdir() if p.suffix != '.json']
        self.assertIn(b'original', backups)
        self.assertEqual((self.local / 'file').read_text(), 'incoming')

    def test_truncated_download_and_changed_destination_preserve_original(self):
        self.prepare()
        tree = Tree(self.local)
        (self.local / 'file').write_text('original')
        old = tree.tag('file')
        (self.cloud / 'file').write_text('new contents')
        with Tree(self.cloud).snapshot('file') as (entry, data):
            with self.assertRaises(Conflict): tree.apply('file', old, entry, io.BytesIO(b'partial'))
            self.assertEqual((self.local / 'file').read_text(), 'original')
            (self.local / 'file').write_text('concurrent edit')
            with self.assertRaises(Conflict): tree.apply('file', old, entry, data)
        self.assertEqual((self.local / 'file').read_text(), 'concurrent edit')


if __name__ == '__main__': unittest.main()
