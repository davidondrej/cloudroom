#!/usr/bin/env python3
"""Disk safety on an explicitly disposable Linux VM. Run as root, never a customer host.
Uses a small disposable tmpfs, cgroup freezing, the Rust API and a protocol fixture.
Model/API fixtures are not a claim of BB or real-inference delivery.
"""
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import subprocess
import sys
import time
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[1]
# CI points this at the optimized build it ships (ADR 0296).
BINARY = Path(os.environ.get('CLOUDROOM_BIN') or ROOT / 'target/debug/cloudroom')


def fixture():
    native = 'disk-' + str(os.getpid())
    home = Path(os.environ['CODEX_HOME']) / 'sessions'
    home.mkdir(exist_ok=True)
    rollout = home / (native + '.jsonl')
    rollout.write_text('{"start":true}\n')
    child = None
    held = []
    def send(v): print(json.dumps(v), flush=True)
    for line in sys.stdin:
        v = json.loads(line); method = v.get('method'); p = v.get('params', {})
        if 'id' not in v: continue
        result = {}
        if method == 'account/read':
            result = {'account': {'type': 'chatgpt', 'email': 'fixture@example.invalid', 'planType': 'plus'}, 'requiresOpenaiAuth': True}
        elif method == 'account/rateLimits/read':
            result = {'rateLimits': {'primary': {'usedPercent': 0}, 'secondary': None}}
        if method == 'thread/inject_items':
            if (Path.cwd() / 'hold-cache').exists():
                held.append(open((Path.cwd() / 'hold-cache').read_text(), 'rb'))
        if method in ('thread/start', 'thread/resume'):
            result = {'thread': {'id': native, 'path': str(rollout)}, 'model': p['model']}
        elif method == 'turn/start':
            turn = p['clientUserMessageId']
            send({'method': 'turn/started', 'params': {'threadId': native, 'turn': {'id': turn, 'status': 'inProgress'}}})
            result = {'turn': {'id': turn}}
            if p['input'][0].get('text') == 'verify attachments':
                images = [Path(item['path']).read_bytes() for item in p['input'] if item['type'] == 'localImage']
                files = [Path(item['text'][16:-1]).read_bytes() for item in p['input']
                         if item['type'] == 'text' and item['text'].startswith('[Attached file: ')]
                assert len(images) == len(files) == 1
                proof = 'attachments read: ' + ' '.join(hashlib.sha256(data).hexdigest() for data in images + files)
                with rollout.open('a') as f: f.write(json.dumps({'turn':turn,'proof':proof})+'\n')
                send({'id':v['id'],'result':result})
                send({'method':'item/agentMessage/delta','params':{'threadId':native,'turnId':turn,'itemId':'proof','delta':proof}})
                send({'method':'turn/completed','params':{'threadId':native,'turn':{'id':turn,'status':'completed'}}})
                continue
            # Detached child proves freeze covers descendants even after setsid().
            child = subprocess.Popen([sys.executable, '-c',
                "from pathlib import Path; import time,os\np=Path('ticks-" + native + "');Path('pid-" + native + "').write_text(str(os.getpid()))\nfor n in range(10000):\n p.write_text(str(n));time.sleep(.05)"],
                start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif method == 'thread/inject_items':
            with (Path.cwd() / ('warning-' + native)).open('a') as f: f.write(json.dumps(p['items']) + '\n')
            with rollout.open('a') as f: f.write(json.dumps({'injected': p['items']}) + '\n')
        send({'id': v['id'], 'result': result})
    if child: child.kill(); child.wait()


def run(*args, **kw):
    p = subprocess.run(args, capture_output=True, text=True, timeout=kw.pop('timeout', 30), **kw)
    if p.returncode: raise AssertionError((args[:3], p.returncode, p.stdout[-2000:], p.stderr[-2000:]))
    return p.stdout.strip()


def wait(check, label, timeout=30):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        result = check()
        if result: return result
        time.sleep(.1)
    raise AssertionError(label)


def main():
    assert os.geteuid() == 0 and sys.argv[1:] in (['--disposable'], ['--disposable', '--mixed']), 'Explicit disposable VM only'
    mixed = '--mixed' in sys.argv
    agent = pwd.getpwnam('cr-disk-test'); service = pwd.getpwnam('cr-service-test')
    unit = 'cloudroom-storage-e2e-' + secrets.token_hex(4)
    base = Path('/var/lib') / unit; base.mkdir(mode=0o755)
    run('mount', '-t', 'tmpfs', '-o', 'size=512m,mode=0755', 'tmpfs', str(base))
    # Test users cannot traverse the CI runner's private checkout. Keep executables
    # outside it and outside the deliberately small data filesystem.
    tools = base.with_name(unit + '-bin'); tools.mkdir(mode=0o755)
    for source in (BINARY, Path(__file__), ROOT/'tests/pi_fixture.py'):
        target = tools/source.name; shutil.copyfile(source, target); target.chmod(0o755)
    for name in ('tmp', 'var-tmp'):
        (base / name).mkdir(); (base / name).chmod(0o1777)
    work = base / 'work'; home = base / 'home'; cache = base / 'cache'; state = base / 'state'
    for p in (work, home, cache, base / 'code'):
        p.mkdir(mode=0o700); os.chown(p, agent.pw_uid, agent.pw_gid)
    state.mkdir(mode=0o700); os.chown(state, service.pw_uid, service.pw_gid)
    (home / '.codex').mkdir(); os.chown(home / '.codex', agent.pw_uid, agent.pw_gid)
    (home / '.codex').chmod(0o700)
    if mixed:
        (home / '.pi/agent').mkdir(parents=True)
        for p in (home / '.pi', home / '.pi/agent'):
            os.chown(p, agent.pw_uid, agent.pw_gid); p.chmod(0o700)
    run('runuser', '-u', agent.pw_name, '--', 'git', 'init', '-q', str(work))
    # An owner-local disposable PostgreSQL; no production data/credentials.
    token = secrets.token_hex(24)
    from fake_api import FakeApi
    api = FakeApi(token, 'disk-fixture')
    policy = dict(agent_uid=agent.pw_uid, agent_gid=agent.pw_gid,
                  cache_dir=str(cache), cgroup_root='/sys/fs/cgroup/system.slice/'+unit+'.service/agents',
                  warning_bytes=200*1024*1024, pause_bytes=100*1024*1024, resume_bytes=160*1024*1024)
    policy_file = base / 'policy.json'; policy_file.write_text(json.dumps(policy)); policy_file.chmod(0o644)
    env = base / 'env'
    env.write_text('\n'.join([f'CLOUDROOM_TOKEN={token}',f'CLOUDROOM_STORAGE_POLICY={policy_file}',f'CLOUDROOM_STATE_DIR={state}',
        f'CLOUDROOM_REPOSITORY={work}',f'CLOUDROOM_ACCOUNT_HOME={home}',f'CLOUDROOM_CODEX_HOME={home}/.codex',
        f'CLOUDROOM_CODEX_BINARY={tools}/storage_e2e.py', 'CLOUDROOM_MODEL=fixture','CLOUDROOM_LISTEN=127.0.0.1:19842',
        'CLOUDROOM_STORE=disk-fixture',f'CLOUDROOM_API_URL={api.url}'])+'\n')
    if mixed:
        with env.open('a') as f:
            f.write(f'CLOUDROOM_PI_BINARY={tools}/pi_fixture.py\nCLOUDROOM_PI_HOME={home}/.pi/agent\nCLOUDROOM_PI_MODEL=fixture\nCLOUDROOM_PI_PROVIDER=fixture\n')
    env.chmod(0o600)
    def ticks():
        return list(work.glob('ticks-*')) + list(work.glob('*.ticks'))
    def request(method, path, body=None, status=200):
        c=http.client.HTTPConnection('127.0.0.1',19842,timeout=5)
        c.request(method,path,body if isinstance(body,bytes) else json.dumps(body) if body is not None else None,
                  {'Authorization':'Bearer '+token,'Content-Type':'application/octet-stream' if isinstance(body,bytes) else 'application/json'})
        r=c.getresponse();text=r.read();c.close(); assert r.status==status,(r.status,text)
        return json.loads(text)
    def ready():
        try:return request('GET','/v1/health')['storage']['level']!='blocked'
        except (OSError,AssertionError):return False
    def session(sid):return request('GET','/v1/sessions/'+sid)['session']
    def events(sid):return request('GET','/v1/sessions/'+sid+'/events')['events']
    def write_as_agent(path, size):
        run('runuser','-u',agent.pw_name,'--','python3','-c',
            "from pathlib import Path\np=Path("+repr(str(path))+ ");p.parent.mkdir(parents=True,exist_ok=True)\nwith p.open('wb') as f:\n for _ in range("+str(size)+"):f.write(b'x'*1048576)")
    checks=[]
    def passed(text):checks.append(text);print('PASS:',text,flush=True)
    try:
        write_as_agent(work/'large-output',300)
        (work/'large-output').unlink()
        run('runuser','-u',service.pw_name,'--','sh','-c','echo protected > '+str(state/'probe'))
        passed('agent writes use actual filesystem capacity, without the former fixed test quota')
        run('systemd-run','--unit='+unit,'--property=User='+service.pw_name,'--property=Group='+service.pw_name,
            '--property=Delegate=yes','--property=AmbientCapabilities=CAP_SETUID CAP_SETGID CAP_DAC_READ_SEARCH CAP_KILL',
            '--property=CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_DAC_READ_SEARCH CAP_KILL','--property=NoNewPrivileges=yes',
            '--property=KillMode=control-group',f'--property=BindPaths={base}/tmp:/tmp {base}/var-tmp:/var/tmp {base}/code:/code',
            '--property=EnvironmentFile='+str(env),str(tools/'cloudroom'))
        wait(ready,'protected core ready')
        assert 'agent_remaining_bytes' not in request('GET','/v1/health')['storage']
        passed('protected service starts with actual free space and delegated workload groups')
        # The same HTTP path that failed in agent-owned 0700 project folders.
        images = [base64.b64decode(value) for value in [
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOoZ/gPAAKAAX8wLww/AAAAAElFTkSuQmCC',
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC']]
        for harness in ['codex','pi'] if mixed else ['codex']:
            sid=request('POST','/v1/sessions',{'request_id':'attachments-'+harness,'harness':harness},202)['session_id']
            peer=request('POST','/v1/sessions',{'request_id':'attachment-retry-'+harness,'harness':harness},202)['session_id']
            native = None
            for turn,image in zip(['initial','follow-up'],images):
                attachments=[]
                payloads=[('image','pixel.png',image),('file','note.txt',('READ_'+harness+'_'+turn+'\n').encode()*8192)]
                for kind,name,content in payloads:
                    key=harness+'-'+turn+'-'+kind
                    url='/v1/sessions/'+sid+'/attachments?'+urlencode(dict(request_id=key,name=name,kind=kind))
                    uploaded=request('POST',url,content,202)['receipt']['input']
                    dest=Path(uploaded['path'])
                    assert dest.read_bytes()==content and uploaded['size']==len(content)
                    for path,mode in [(dest,0o600), *((p,0o700) for p in [dest.parent,dest.parent.parent,dest.parent.parent.parent])]:
                        info=path.stat()
                        assert (info.st_uid,info.st_gid,info.st_mode & 0o777)==(agent.pw_uid,agent.pw_gid,mode),path
                    assert run('runuser','-u',agent.pw_name,'--','sha256sum',str(dest)).split()[0]==hashlib.sha256(content).hexdigest()
                    before=dest.stat()
                    assert request('POST',url,content,202)['receipt']['input']==uploaded
                    # A new session has no upload receipt: retry also exercises the file helper's existing-file path.
                    retry_url=url.replace('/'+sid+'/', '/'+peer+'/')
                    assert request('POST',retry_url,content,202)['receipt']['input']==uploaded
                    after=dest.stat()
                    assert (before.st_ino,before.st_mtime_ns)==(after.st_ino,after.st_mtime_ns)
                    assert dest.read_bytes()==content and not list(dest.parent.glob('.attachment-*'))
                    attachments.append(uploaded)
                prompt=dict(request_id=turn,text='verify attachments',attachments=attachments)
                request('POST','/v1/sessions/'+sid+'/prompts',prompt,202)
                wait(lambda:session(sid)['receipts'][turn]['state']=='completed','attachment read by '+harness)
                current=session(sid)
                if native is not None: assert current['native_id']==native
                native=current['native_id']
                request('POST','/v1/sessions/'+sid+'/prompts',prompt,202)
                proof='attachments read: '+' '.join(hashlib.sha256(data).hexdigest() for _,_,data in payloads)
                wait(lambda:any(proof in json.dumps(record) for record in events(sid)),'attachment read proof')
                dispatches=[r for r in events(sid) if r['kind']=='state' and r['data'].get('state')=='starting_turn' and r['data'].get('request_id')==turn]
                assert len(dispatches)==1
            for target in [sid,peer]:
                wait(lambda:session(target)['state']=='idle','attachment session idle')
                request('POST','/v1/sessions/'+target+'/close',{'request_id':'close'},202)
                wait(lambda:session(target)['state']=='closed','attachment session closed')
            passed(harness+' initial/follow-up image and file: HTTP bytes, agent UID/GID/modes/read proof, upload and prompt retries')
        ids=[]
        for name in ('a','b'):
            body = {'request_id':name}
            if mixed and name == 'b': body['harness'] = 'pi'
            sid=request('POST','/v1/sessions',body,202)['session_id']; ids.append(sid)
            wait(lambda:session(sid)['state']=='idle','session initialization')
            request('POST','/v1/sessions/'+sid+'/prompts',{'request_id':'job-'+name,'text':'hold'},202)
        wait(lambda:len(ticks())==2,'two live tools')
        names=[session(s)['native_id'] for s in ids]
        for p in [*work.glob('pid-*'), *work.glob('*.pid')]:
            pid=p.read_text(); status=Path('/proc/'+pid+'/status').read_text()
            assert 'NoNewPrivs:\t1' in status and 'CapEff:\t0000000000000000' in status
        passed('two real detached tool processes run unprivileged without service capabilities')
        # Narrow content-addressed cache plus sensitive sentinel and deliberately wrong digest.
        data=b'x'*1048576*96; digest=hashlib.sha512(data).hexdigest()
        blob=cache/'npm/_cacache/content-v2/sha512'/digest[:2]/digest[2:4]/digest[4:]
        write_as_agent(blob,96)
        sensitive=work/'.env'; sensitive.write_text('synthetic-secret'); os.chown(sensitive,agent.pw_uid,agent.pw_gid)
        fake=blob.with_name('f'*124); fake.write_text('do not delete'); os.chown(fake,agent.pw_uid,agent.pw_gid)
        # A valid cache blob held open by a running harness must survive cleanup.
        active_data=b'active cache data'; active_hash=hashlib.sha512(active_data).hexdigest()
        active=cache/'npm/_cacache/content-v2/sha512'/active_hash[:2]/active_hash[2:4]/active_hash[4:]
        active.parent.mkdir(parents=True,exist_ok=True); active.write_bytes(active_data)
        for p in (active.parent.parent,active.parent,active):os.chown(p,agent.pw_uid,agent.pw_gid)
        held=work/'hold-cache';held.write_text(str(active));os.chown(held,agent.pw_uid,agent.pw_gid)
        # Even a valid hash with another hardlink is not owned disposable storage.
        linked_data=b'customer kept this'; linked_hash=hashlib.sha512(linked_data).hexdigest()
        linked=cache/'npm/_cacache/content-v2/sha512'/linked_hash[:2]/linked_hash[2:4]/linked_hash[4:]
        linked.parent.mkdir(parents=True,exist_ok=True);linked.write_bytes(linked_data)
        for p in (linked.parent.parent,linked.parent,linked):os.chown(p,agent.pw_uid,agent.pw_gid)
        os.link(linked,work/'kept-output')
        symlink=blob.parent/('e'*124);symlink.symlink_to(sensitive)
        filler=work/'large-output'; write_as_agent(filler,shutil.disk_usage(base).free//1048576-180)
        filler_size=filler.stat().st_size
        wait(lambda:request('GET','/v1/health')['storage']['level']=='low_space','warning threshold')
        storage=request('GET','/v1/dashboard')['storage']
        assert storage['level']=='low_space' and storage['reason']=='disk_capacity'
        assert 0 < storage['workspace_available_bytes'] <= storage['workspace_total_bytes']
        assert 0 < storage['history_available_bytes'] <= storage['history_total_bytes']
        assert 0 <= time.time()*1000-storage['sampled_at'] < 5000
        wait(lambda:all((work/('warning-'+n)).exists() for n in names),'native warning delivered to every busy agent')
        for sid in ids:
            records=events(sid); warnings=[r for r in records if r['kind']=='storage_warning'];assert len(warnings)==1
            # Reconnect reads and live SSE expose the same saved system warning.
            c=http.client.HTTPConnection('127.0.0.1',19842,timeout=5)
            c.request('GET','/v1/sessions/'+sid+'/stream?after='+str(warnings[0]['sequence']-1),headers={'Authorization':'Bearer '+token})
            response=c.getresponse();assert response.status==200
            while True:
                line=response.readline().decode()
                if line.startswith('data:'):
                    assert json.loads(line[5:])['kind']=='storage_warning';break
            response.close();c.close()
        assert request('GET','/v1/ready')['ready']
        extra_sid=request('POST','/v1/sessions',{'request_id':'warning-allowed'},202)['session_id']
        wait(lambda:session(extra_sid)['state']=='idle','new session during warning')
        request('POST','/v1/sessions/'+extra_sid+'/close',{'request_id':'close'},202)
        request('POST','/v1/sessions/'+ids[0]+'/prompts',{'request_id':'warning-input','text':'hold'},202)
        request('POST','/v1/sync',{'device':'fixture','repositories':[]})
        request('GET','/v1/sync/settings-codex?device=fixture')
        passed('warning reaches busy harnesses and replay; new sessions, queued prompts and sync still work')
        time.sleep(3)
        for n in names:assert len((work/('warning-'+n)).read_text().splitlines())==1
        passed('warnings are deduplicated during one low-space episode')
        extra=work/'more-output'; write_as_agent(extra,105)
        wait(lambda:not blob.exists(),'safe cache cleanup',40)
        wait(ready,'automatic recovery after cache cleanup',40)
        wait(lambda:all(not session(s)['storage_paused'] for s in ids),'resume while warning remains')
        for n in names:assert len((work/('warning-'+n)).read_text().splitlines())==1
        assert fake.read_text()=='do not delete' and sensitive.read_text()=='synthetic-secret'
        assert active.read_bytes()==active_data and linked.read_bytes()==linked_data and symlink.is_symlink()
        passed('active cache files, hardlinked outputs, symlinks and wrong-hash files survive cleanup')
        assert filler.stat().st_size==filler_size and extra.stat().st_size==105*1048576
        assert request('GET','/v1/health')['storage']['level']=='low_space'
        for sid,n in zip(ids,names):
            records=events(sid)
            assert any(r['kind']=='storage_pause' for r in records)
            assert any(r['kind']=='storage_pause' and not r['data']['paused'] for r in records)
            assert session(sid)['native_id']==n
        passed('same workloads resume above the recovery threshold while the low-space warning remains')
        before={p:p.read_text() for p in ticks()};time.sleep(.3)
        assert all(p.read_text()!=v for p,v in before.items())
        passed('descendants resume in place without duplicate prompts')
        # No disposable cache remains: remain paused until the operator frees generated output.
        write_as_agent(work/'final-output',105)
        wait(lambda:all(session(s)['storage_paused'] for s in ids),'emergency pause',30)
        before={p:p.read_text() for p in ticks()};time.sleep(.3)
        assert all(p.read_text()==v for p,v in before.items())
        assert request('GET','/v1/health')['status']=='ready'
        assert next(h for h in request('GET','/v1/capabilities')['harnesses'] if h['id']=='codex')['models'] is None
        request('POST','/v1/sessions',{'request_id':'blocked'},409)
        request('POST','/v1/sessions/'+ids[0]+'/prompts',{'request_id':'blocked-input','text':'never run'},409)
        assert request('GET','/v1/sessions/'+ids[0]+'/events')['events']
        # The pause may never lift on its own, so the sandbox must still be allowed to sleep.
        assert request('POST','/v1/drain',{'hold':True})['drained'] is True
        request('POST','/v1/drain',{'hold':False})
        passed('emergency pause blocks new writes but leaves core and saved history readable')
        (work/'final-output').unlink();filler.unlink();extra.unlink()
        wait(ready,'operator recovery',30)
        wait(lambda:all(not session(s)['storage_paused'] for s in ids),'confirmed thaw')
        passed('operator frees output; only storage-paused workloads are thawed')
        api.down = True
        write_as_agent(work/'db-outage-output',shutil.disk_usage(base).free//1048576-75)
        wait(lambda:all(session(s)['storage_paused'] for s in ids),'disk emergency during an API outage')
        assert request('GET','/v1/health')['saving']['pending_records']>0
        (work/'db-outage-output').unlink(); wait(ready,'disk recovery during an API outage')
        passed('an API outage preserves pending history while local disk emergency pauses work')
        missing=base/'unavailable'; work.rename(missing)
        wait(lambda:request('GET','/v1/health')['storage']['reason']=='measurement_unavailable','missing filesystem fails closed')
        request('POST','/v1/sessions',{'request_id':'missing-disk'},409)
        missing.rename(work); wait(ready,'filesystem measurements recover')
        passed('failed filesystem measurements pause work; restored measurements permit recovery')
        # Frozen work never frees space, so a pause that cannot recover stops the writer and resumes work.
        write_as_agent(work/'rescue-output',shutil.disk_usage(base).free//1048576-75)
        wait(lambda:all(session(s)['storage_paused'] for s in ids),'pause before rescue')
        wait(lambda:all(not session(s)['storage_paused'] for s in ids),'rescue resumes work',60)
        for sid in ids:assert any(r['kind']=='storage_warning' and r['data'].get('reason')=='rescue' for r in events(sid))
        (work/'rescue-output').unlink()
        passed('a pause that cannot recover stops the writing command and resumes work')
    except Exception:
        subprocess.run(['journalctl','--unit='+unit,'--no-pager','--lines=80'],check=False)
        try: print('Core health:',json.dumps(request('GET','/v1/health')),flush=True)
        except (OSError,AssertionError): pass
        raise
    finally:
        subprocess.run(['systemctl','stop',unit],capture_output=True,timeout=20)
        api.close()
        evidence=ROOT/'private/storage-e2e.json';evidence.parent.mkdir(exist_ok=True)
        evidence.write_text(json.dumps({'checks':checks,'fixture':True,'harnesses':['codex','pi'] if mixed else ['codex'],'root':str(base)},indent=2))
        os.chown(evidence.parent,ROOT.stat().st_uid,ROOT.stat().st_gid)
        os.chown(evidence,ROOT.stat().st_uid,ROOT.stat().st_gid)
        # Keep logs/history for investigation; discard only this test's large filler files.
        for p in work.glob('*output'):p.unlink(missing_ok=True)
        shutil.copytree(state,evidence.parent/(unit+'-history'))
        run('umount',str(base));base.rmdir();shutil.rmtree(tools)
    print('Storage checks:',len(checks))

if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='app-server':fixture()
    else:main()
