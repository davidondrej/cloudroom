"""Direct HTTP starts and durable workspace recovery; archive imports are retired."""
import concurrent.futures
import http.client
import json
from pathlib import Path
import secrets
import time
import unittest

import core_fixture
from core_e2e import until, run


class WorkspaceTests(unittest.TestCase):
    setUp, tearDown, start = core_fixture.ReplayTests.setUp, core_fixture.ReplayTests.tearDown, core_fixture.ReplayTests.start

    def pi(self):
        home = self.root / 'pi-home'; home.mkdir(exist_ok=True)
        self.env.update(CLOUDROOM_PI_HOME=str(home), CLOUDROOM_PI_BINARY=str(Path(__file__).with_name('pi_fixture.py').resolve()), CLOUDROOM_PI_MODEL='fixture', CLOUDROOM_PI_PROVIDER='fixture')

    def api(self):
        from fake_api import FakeApi
        api = FakeApi(self.env['CLOUDROOM_TOKEN'], 'cloudroom-workspace')
        self.addCleanup(api.close)
        self.env.pop('CLOUDROOM_LOCAL_HISTORY', None)
        self.env.update(api.env())
        return api

    def seed(self, key, path, harness='codex', paused=False, parent=None, legacy_state=None):
        workspace = {'id':key,'path':str(path.resolve()), **({'parent':parent} if parent else {})}
        registry = self.state / 'workspaces'; registry.mkdir(exist_ok=True)
        (registry / (key + '.pending')).write_text(json.dumps(workspace))
        records = [('receipt', {'request_id':key,'command':'start','input':{'workspace':key, **({'harness':harness} if harness!='codex' else {})},'workspace':workspace,'state':'accepted'})]
        if legacy_state: records.append(('state', {'state':legacy_state}))
        records.append(('receipt', {'request_id':'first','command':'prompt','input':{'text':'hello'},'state':'accepted'}))
        if paused: records.append(('receipt', {'request_id':'stop','command':'stop','input':{},'state':'accepted'}))
        sequence = len(list(self.state.glob('*.record')))
        for kind, data in records:
            sequence += 1
            (self.state / f'{sequence:020}.record').write_text(json.dumps({'sequence':sequence,'session_id':'cr_'+key,'kind':kind,'data':data}))
        return workspace

    def test_new_empty_folders_collisions_concurrent_starts_and_retry(self):
        self.api(); self.pi(); self.start()
        samples = []
        for kind in ['codex','pi']:
            key = kind + '-empty'
            body = {'request_id':key,'harness':kind,'workspace':key,'workspace_name':'project'}
            started = time.monotonic()
            accepted = self.service.request('POST','/v1/sessions',body,202)
            sid = accepted['session_id']
            connection = http.client.HTTPConnection(self.service.address, timeout=10)
            connection.request('POST',f'/v1/sessions/{sid}/attachments?request_id=attachment&name=note.txt&kind=file',b'explicit attachment',{'Authorization':'Bearer '+self.env['CLOUDROOM_TOKEN'],'Content-Type':'application/octet-stream'})
            response = connection.getresponse()
            uploaded = json.loads(response.read()); connection.close()
            self.assertEqual(response.status,202,uploaded)
            self.assertEqual(Path(uploaded['receipt']['input']['path']).read_bytes(),b'explicit attachment')
            self.service.request('POST',f'/v1/sessions/{sid}/prompts',{'request_id':'hello','text':'hello'},202)
            until(lambda:self.service.session(sid)['receipts']['hello']['state']=='completed', 'empty '+kind, 10)
            samples.append(round(time.monotonic()-started,3))
            first = self.service.session(sid)
            self.assertEqual(first['receipts'][key]['state'],'completed')
            self.assertFalse((Path(first['workspace']['path']) / '.git').exists())
            self.assertEqual(self.service.request('GET',f'/v1/sessions/{sid}/workspace')['branch'],None)
            self.service.request('POST','/v1/sessions',body,202)
            self.assertEqual(self.service.session(sid)['native_id'],first['native_id'])
            self.service.request('POST','/v1/sessions',{**body,'workspace_name':'different'},409)
        self.assertNotEqual(self.service.session('cr_codex-empty')['workspace']['path'],self.service.session('cr_pi-empty')['workspace']['path'])
        path = Path(self.service.session('cr_codex-empty')['workspace']['path'])
        (path / 'keep').write_text('cloud work')
        def create(key):
            return self.service.request('POST','/v1/sessions',{'request_id':key,'workspace':'codex-empty'},202)
        with concurrent.futures.ThreadPoolExecutor(2) as pool: results = list(pool.map(create,['peer-a','peer-b']))
        for item in results:
            until(lambda:self.service.session(item['session_id'])['state']=='idle','peer',10)
            self.assertEqual(self.service.session(item['session_id'])['workspace']['path'],str(path))
        self.assertEqual((path/'keep').read_text(),'cloud work')
        print('Direct empty-folder start + attachment + first prompt (protocol fixtures), seconds:',samples)

    def test_attachment_bytes_limits_retry_and_no_symlink_escape(self):
        self.pi()
        paths = {kind:self.state.resolve()/'code'/kind for kind in ['codex','pi']}
        for kind,path in paths.items(): self.seed(kind,path,kind)
        self.start()
        def upload(kind, key, name, content, media='file', expected=202, parts=''):
            connection = http.client.HTTPConnection(self.service.address, timeout=10)
            connection.request('POST',f'/v1/sessions/cr_{kind}/attachments?request_id={key}&name={name}&kind={media}{parts}',content,
                {'Authorization':'Bearer '+self.env['CLOUDROOM_TOKEN'],'Content-Type':'application/octet-stream'})
            response = connection.getresponse()
            data = json.loads(response.read()); connection.close()
            self.assertEqual(response.status,expected,data)
            return data
        for kind,path in paths.items():
            until(lambda:self.service.session('cr_'+kind)['state']=='idle','attachment target',10)
            path.chmod(0o700)
            for index, (blocked, mode) in enumerate([(path, 0o000), (path/'.cloudroom', 0o000),
                    (path/'.cloudroom/attachments', 0o500), (path/'.cloudroom/attachments/denied-3', 0o500)]):
                blocked.mkdir(mode=0o700, exist_ok=True)
                blocked.chmod(mode)
                try:
                    denied = upload(kind,'denied-'+str(index),'note.txt',b'retry me',expected=409)
                    self.assertEqual(denied, {'code':'attachment_permission_denied','error':'Cloud folder permission denied'})
                    self.assertNotIn('denied-'+str(index),self.service.session('cr_'+kind)['receipts'])
                finally:
                    blocked.chmod(0o700)
                retried = upload(kind,'denied-'+str(index),'note.txt',b'retry me')['receipt']['input']
                self.assertEqual(Path(retried['path']).read_bytes(),b'retry me')
            payload = ('ATTACHMENT_'+kind+'\\n').encode()*10000
            uploaded = upload(kind,'note','note.txt',payload)['receipt']['input']
            dest = Path(uploaded['path'])
            self.assertEqual(dest.read_bytes(),payload)
            self.assertEqual(uploaded['size'],len(payload))
            self.assertEqual(dest.stat().st_mode & 0o777,0o600)
            self.assertEqual(upload(kind,'note','note.txt',payload)['receipt']['input'],uploaded)
            # Large files arrive in 4 MiB parts: a repeated part is ignored, a gap is refused, the last part saves.
            big, size = secrets.token_bytes(9*1024**2), 4*1024**2
            def part(offset, expected=202):
                return upload(kind,'parts','big.bin',big[offset:offset+size],expected=expected,parts=f'&offset={offset}&total={len(big)}')
            self.assertEqual(part(0),{'received':size})
            self.assertEqual(part(0),{'received':size})
            self.assertIn('out of order',part(2*size,409)['error'])
            self.assertEqual(part(size),{'received':2*size})
            saved = part(2*size)['receipt']['input']
            self.assertEqual(Path(saved['path']).read_bytes(),big)
            self.assertEqual(part(2*size)['receipt']['input'],saved)
            self.assertEqual(upload(kind,'parts-large','big.bin',b'x',expected=409,parts=f'&offset=0&total={100*1024**2+1}')['code'],'attachment_too_large')
            for media,limit in [('image',10*1024**2),('file',100*1024**2)]:
                too_large = upload(kind,'large-'+media,'large',b'x'*(limit+1),media,409)
                self.assertEqual(too_large['code'],'attachment_too_large')
                self.assertFalse((path/'.cloudroom/attachments'/('large-'+media)/'large').exists())
            outside = self.root.resolve()/('outside-'+kind); outside.mkdir()
            (outside/'keep').write_text('untouched')
            (path/'.cloudroom/attachments/escape').symlink_to(outside)
            upload(kind,'escape','keep',b'changed',expected=409)
            linked = path/'.cloudroom/attachments/linked'; linked.mkdir()
            (linked/'keep').symlink_to(outside/'keep')
            upload(kind,'linked','keep',b'changed',expected=409)
            temporary = path/'.cloudroom/attachments/temporary'; temporary.mkdir()
            (temporary/'.note.txt.tmp').symlink_to(outside/'keep')
            temporary_upload = upload(kind,'temporary','note.txt',b'normal upload')['receipt']['input']
            self.assertEqual(Path(temporary_upload['path']).read_bytes(),b'normal upload')
            self.assertTrue((temporary/'.note.txt.tmp').is_symlink())
            upload(kind,'traversal','..%2Fkeep',b'changed',expected=409)
            self.assertEqual((outside/'keep').read_text(),'untouched')
            self.assertFalse(list(path.rglob('.attachment-*')))
            self.service.request('POST',f'/v1/sessions/cr_{kind}/prompts',
                {'request_id':'read','text':'read attachment','attachments':[uploaded]},202)
            until(lambda:self.service.session('cr_'+kind)['receipts']['read']['state']=='completed','attachment prompt',10)

    def assert_single_dispatch(self, kind, path, native):
        if kind == 'codex':
            self.assertEqual((path/(native+'.requests')).read_text().splitlines(),['first'])
        else:
            until(lambda:self.service.session('cr_'+kind)['native_path'] is not None,'Pi history',10)
            records = [json.loads(line) for line in Path(self.service.session('cr_'+kind)['native_path']).read_text().splitlines()]
            self.assertEqual(records[0]['cwd'],str(path))
            self.assertEqual([r['message']['content'] for r in records if r.get('message',{}).get('role')=='user'],['hello'])

    def test_old_pending_starts_launch_in_empty_folders_and_resume_once(self):
        self.pi()
        paths = {kind:self.state.resolve()/'code'/kind for kind in ['codex','pi']}
        for kind,path in paths.items(): self.seed(kind,path,kind,legacy_state='waiting_for_files')
        self.start()
        identities = {}
        for kind,path in paths.items():
            sid = 'cr_'+kind
            until(lambda:self.service.session(sid)['receipts']['first']['state']=='completed','old pending '+kind,10)
            identities[kind] = self.service.session(sid)['native_id']
            self.assert_single_dispatch(kind,path,identities[kind])
        self.service.stop(); self.start()
        for kind,path in paths.items():
            until(lambda:self.service.session('cr_'+kind)['state']=='idle','resume '+kind,10)
            self.assertEqual(self.service.session('cr_'+kind)['native_id'],identities[kind])
            self.assert_single_dispatch(kind,path,identities[kind])

    def test_paused_start_keeps_queue_paused_and_nested_mapping(self):
        parent = self.state.resolve()/'code/project'
        self.seed('parent',parent)
        child = parent/'nested/child'
        self.seed('child',child,paused=True,parent='parent')
        self.start()
        until(lambda:self.service.session('cr_child')['state']=='idle','paused child',10)
        self.assertTrue(child.is_dir())
        self.assertTrue(self.service.session('cr_child')['queue_paused'])
        self.assertEqual(self.service.session('cr_child')['receipts']['first']['state'],'accepted')
        self.service.request('POST','/v1/sessions/cr_child/resume',{'request_id':'resume'},202)
        until(lambda:self.service.session('cr_child')['receipts']['first']['state']=='completed','resume child',10)
        self.assertEqual(self.service.session('cr_child')['workspace']['path'],str(child))

    def test_existing_dirty_git_and_files_are_untouched(self):
        path = self.state.resolve()/'code/project'; path.mkdir(parents=True)
        run('git','init','-q',str(path))
        (path/'file').write_text('base')
        run('git','-C',str(path),'add','.')
        run('git','-C',str(path),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','base')
        (path/'file').write_text('staged'); run('git','-C',str(path),'add','file')
        (path/'file').write_text('unstaged'); (path/'.env').write_text('SYNTHETIC=keep')
        before = run('git','-C',str(path),'show',':file')
        self.seed('dirty',path); self.start()
        until(lambda:self.service.session('cr_dirty')['receipts']['first']['state']=='completed','dirty folder',10)
        self.assertEqual((path/'file').read_text(),'unstaged')
        self.assertEqual(run('git','-C',str(path),'show',':file'),before)
        self.assertEqual((path/'.env').read_text(),'SYNTHETIC=keep')
        self.assertIsNotNone(self.service.request('GET','/v1/sessions/cr_dirty/workspace')['head'])

    def test_path_escape_is_rejected_without_touching_outside_files(self):
        root = self.state.resolve()/'code'; root.mkdir()
        outside = self.root.resolve()/'outside'; outside.mkdir()
        (outside/'keep').write_text('private')
        for key in ['escape', 'legacy']:
            (root/key).symlink_to(outside)
            self.seed(key,root/key)
            # Preserve lexical paths so the no-follow directory walk must reject them.
            lexical = str(root/key)
            pending = self.state/f'workspaces/{key}.pending'
            pending.write_text(json.dumps({'id':key,'path':lexical}))
            record = next(path for path in self.state.glob('*.record')
                          if json.loads(path.read_text()).get('data',{}).get('request_id') == key)
            value=json.loads(record.read_text()); value['data']['workspace']['path']=lexical;record.write_text(json.dumps(value))
        (self.state/'snapshot.json').unlink(missing_ok=True)  # Core trusts its snapshot over edited old records.
        self.start()
        for key in ['escape', 'legacy']:
            until(lambda:self.service.session('cr_'+key)['state']=='failed','invalid mapping '+key,10)
        self.assertFalse((outside/'child').exists())
        self.assertEqual((outside/'keep').read_text(),'private')
        self.service.request('POST','/v1/sessions',{'request_id':'bad','workspace':'../outside'},409)
        self.service.request('POST','/v1/sessions',{'request_id':'bad','workspace':'good','workspace_name':'../outside'},409)
        self.service.request('POST','/v1/sessions',{'request_id':'bad','workspace':'good'},401,token=None)
        self.service.request('POST','/v1/workspaces/old',{},405)
        self.service.request('POST','/v1/workspaces/old/prepare',{},404)


if __name__ == '__main__': unittest.main()
