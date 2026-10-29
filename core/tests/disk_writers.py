"""Real Linux cgroup/HTTP checks. Only run in an explicitly disposable privileged container."""
import concurrent.futures
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.parse import urlencode

assert sys.platform == 'linux' and os.geteuid() == 0 and Path('/.dockerenv').exists() and sys.argv[1:] == ['--disposable'], 'disposable Linux container only'
CORE = Path(__file__).resolve().parents[1]
# CI points this at the optimized build it ships (ADR 0296).
BINARY = Path(os.environ.get('CLOUDROOM_BIN') or CORE / 'target/debug/cloudroom')
BASE = Path('/var/lib/cloudroom-disk-probe')
TOOLS = Path('/opt/cloudroom-disk-probe')
checks = {}

def run(*args):
    subprocess.run(args, check=True, capture_output=True)

def wait(check, label, seconds=12):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        value=check()
        if value: return value
        time.sleep(.02)
    raise AssertionError(label)

run('mount','-o','remount,rw','/sys/fs/cgroup')
BASE.mkdir(mode=0o755)
run('mount','-t','tmpfs','-o','size=256m,mode=0755','tmpfs',str(BASE))
TOOLS.mkdir(mode=0o755)
for name in ['core_fixture.py','core_e2e.py']:
    shutil.copyfile(CORE/'tests'/name,TOOLS/name);(TOOLS/name).chmod(0o755)
for name in ['home','cache','code','tmp','var-tmp']:
    path=BASE/name;path.mkdir();os.chown(path,1001,1001);path.chmod(0o1777 if name in ['tmp','var-tmp'] else 0o700)
for source,target in [('tmp','/tmp'),('var-tmp','/var/tmp')]:
    run('mount','--bind',str(BASE/source),target)
Path('/code').mkdir(exist_ok=True);os.chown('/code',1001,1001)
relative=next(line[3:] for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
GROUP=Path('/sys/fs/cgroup')/relative.lstrip('/')/'agents'
policy=BASE/'policy.json'
policy.write_text(json.dumps({'agent_uid':1001,'agent_gid':1001,'cache_dir':str(BASE/'cache'),'cgroup_root':str(GROUP),'warning_bytes':96*1024**2,'pause_bytes':64*1024**2,'resume_bytes':80*1024**2}))
policy.chmod(0o600)
TOKEN='disposable-disk-fixture-'+'x'*32
process=None;log=None;address=None

def seed(name):
    state=BASE/name;state.mkdir(mode=0o700)
    home=BASE/'home/.codex';(home/'sessions').mkdir(parents=True,exist_ok=True)
    project=Path('/code/project');project.mkdir(exist_ok=True);os.chown(project,1001,1001)
    native=home/'sessions/disk-native.jsonl';native.write_text('{"seed":true}\n')
    for path in [home,home/'sessions',native]:os.chown(path,1001,1001)
    workspace={'id':'project','path':str(project)}
    (state/'workspaces').mkdir();(state/'workspaces/project.json').write_text(json.dumps(workspace))
    records=[('receipt',{'request_id':'start','command':'start','input':{},'model':'fixture','workspace':workspace,'state':'completed'}),('native_identity',{'id':'disk-native','path':str(native)}),('state',{'state':'idle'})]
    for n,(kind,data) in enumerate(records,1):
        (state/f'{n:020}.record').write_text(json.dumps({'sequence':n,'session_id':'cr_probe','kind':kind,'data':data}))
    return {'PATH':'/usr/local/bin:/usr/bin:/bin','CLOUDROOM_STORAGE_POLICY':str(policy),'CLOUDROOM_LISTEN':'127.0.0.1:0','CLOUDROOM_TOKEN':TOKEN,'CLOUDROOM_ACCOUNT_HOME':str(BASE/'home'),'CLOUDROOM_REPOSITORY':str(BASE/'home'),'CLOUDROOM_STATE_DIR':str(state),'CLOUDROOM_LOCAL_HISTORY':'1','CLOUDROOM_STORE':'fixture','CLOUDROOM_CODEX_BINARY':str(TOOLS/'core_fixture.py'),'CLOUDROOM_CODEX_HOME':str(home),'CLOUDROOM_MODEL':'fixture'}

def start(env,name):
    global process,log,address
    path=BASE/(name+'.log');log=path.open('w+')
    process=subprocess.Popen([str(BINARY)],env=env,stdout=log,stderr=log)
    until=time.monotonic()+10
    while time.monotonic()<until:
        text=path.read_text()
        lines=[line.split()[-1] for line in text.splitlines() if line.startswith('Cloudroom listening on ')]
        if lines: address=lines[0];return True
        if process.poll() is not None:return False
        time.sleep(.02)
    raise AssertionError('core did not start: '+path.read_text())

def stop():
    global process
    if process and process.poll() is None:
        process.terminate()
        try:process.wait(timeout=8)
        except subprocess.TimeoutExpired:process.kill();process.wait()
    if log:log.close()
    process=None

def request(method,path,body=None):
    connection=http.client.HTTPConnection(address,timeout=25)
    headers={'Authorization':'Bearer '+TOKEN,'Content-Type':'application/json' if isinstance(body,dict) else 'application/octet-stream'}
    connection.request(method,path,json.dumps(body) if isinstance(body,dict) else body,headers)
    response=connection.getresponse();value=response.read();connection.close()
    return response.status,json.loads(value) if value else None

def level():return request('GET','/v1/health')[1]['storage']['level']
def session():return request('GET','/v1/sessions/cr_probe')[1]['session']
def groups():return set(GROUP.glob('agent-*'))
def pids(group):
    try:return [int(v) for v in (group/'cgroup.procs').read_text().split()]
    except FileNotFoundError:return []
def frozen(group):return (group/'cgroup.events').exists() and 'frozen 1' in (group/'cgroup.events').read_text()
def new_writer(before):
    return next((g for g in groups()-before if pids(g)),None)

def fill():
    remaining=shutil.disk_usage(BASE).free-40*1024**2
    with (BASE/'filler').open('wb') as output:
        while remaining>0:
            chunk=b'x'*min(1024**2,remaining);output.write(chunk);remaining-=len(chunk)
    wait(lambda:level()=='blocked','disk guard blocks')
    wait(lambda:session()['storage_paused'],'session frozen')

def free():
    (BASE/'filler').unlink(missing_ok=True)
    wait(lambda:level()!='blocked','disk recovered')
    wait(lambda:not session()['storage_paused'],'session thawed')

try:
    accepted=start(seed('wrong-volume-state'),'wrong-volume')
    checks['unmonitored_code_volume_rejected']=not accepted
    stop()
    run('mount','--bind',str(BASE/'code'),'/code')
    assert start(seed('state'),'service'),(BASE/'service.log').read_text()
    wait(lambda:session()['state']=='idle','native session ready')
    assert request('POST','/v1/sync',{'device':'fixture'})[0]==200
    assert request('GET','/v1/sync/skills-shared?device=fixture')[0]==200
    cloud=BASE/'home/.agents/skills'
    size=16*1024**2;chunk=b'x'*(256*1024)
    digest=hashlib.sha256(b'fileFalse'+b'x'*size).hexdigest()
    query=urlencode({'device':'fixture','path':'large','kind':'file','incoming':digest,'size':size,'executable':'false'})
    before=groups()
    upload=http.client.HTTPConnection(address,timeout=25)
    upload.putrequest('PUT','/v1/sync/skills-shared/file?'+query)
    upload.putheader('Authorization','Bearer '+TOKEN);upload.putheader('Transfer-Encoding','chunked');upload.endheaders()
    def send_chunks(amount):
        for _ in range(amount//len(chunk)):upload.send(f'{len(chunk):x}\r\n'.encode()+chunk+b'\r\n')
    send_chunks(4*1024**2)
    group=wait(lambda:new_writer(before),'active sync writer')
    def staged_size():return sum(p.stat().st_size for p in (cloud/'.cloudroom-sync-pending').glob('*') if p.is_file() and p.suffix!='.json')
    wait(lambda:staged_size()>=4*1024**2,'staged upload prefix')
    fill()
    checks['active_upload_frozen']=frozen(group)
    before_size=staged_size()
    with concurrent.futures.ThreadPoolExecutor(1) as pool:
        sending=pool.submit(send_chunks,2*1024**2)
        time.sleep(.3)
        checks['active_upload_stops_writing']=staged_size()==before_size
        status,_=request('POST','/v1/sessions/cr_probe/attachments?request_id=blocked&name=note.txt&kind=file',b'no writes')
        checks['blocked_attachment_rejected']=status==409 and not Path('/code/project/.cloudroom/attachments/blocked/note.txt').exists()
        free();sending.result(timeout=10)
    send_chunks(size-6*1024**2);upload.send(b'0\r\n\r\n')
    response=upload.getresponse();result=json.loads(response.read());upload.close()
    checks['upload_resumes_without_corruption']=response.status==200 and result['ok'] and (cloud/'large').read_bytes()==b'x'*size
    # Hold the new download worker before it stages a snapshot; then exercise the real emergency freeze.
    before=groups()
    def download():
        connection=http.client.HTTPConnection(address,timeout=25)
        connection.request('GET','/v1/sync/skills-shared/file?'+urlencode({'device':'fixture','path':'large','expected':digest}),headers={'Authorization':'Bearer '+TOKEN})
        response=connection.getresponse();body=response.read();connection.close()
        return response.status,hashlib.sha256(body).hexdigest()
    with concurrent.futures.ThreadPoolExecutor(1) as pool:
        downloaded=pool.submit(download)
        group=wait(lambda:new_writer(before),'download worker')
        pid=pids(group)[0];os.kill(pid,signal.SIGSTOP)
        fill();checks['download_staging_frozen']=frozen(group)
        os.kill(pid,signal.SIGCONT);time.sleep(.2)
        checks['download_waits_while_blocked']=not downloaded.done()
        free()
        status,checksum=downloaded.result(timeout=15)
        checks['download_resumes_without_corruption']=status==200 and checksum==hashlib.sha256(b'x'*size).hexdigest()
    # A disconnected upload must leave the old file usable and allow a clean retry.
    (cloud/'cancelled').write_bytes(b'original');os.chown(cloud/'cancelled',1001,1001)
    old=hashlib.sha256(b'fileFalseoriginal').hexdigest()
    cancelled_query=urlencode({'device':'fixture','path':'cancelled','kind':'file','expected':old,'incoming':digest,'size':size,'executable':'false'})
    before=groups()
    upload=http.client.HTTPConnection(address,timeout=25)
    upload.putrequest('PUT','/v1/sync/skills-shared/file?'+cancelled_query)
    upload.putheader('Authorization','Bearer '+TOKEN);upload.putheader('Transfer-Encoding','chunked');upload.endheaders()
    send_chunks(4*1024**2)
    group=wait(lambda:new_writer(before),'cancellable writer')
    wait(lambda:staged_size()>=4*1024**2,'partial cancelled upload')
    upload.close();wait(lambda:not pids(group),'cancelled writer exited')
    checks['cancelled_transfer_preserves_original']=(cloud/'cancelled').read_bytes()==b'original'
    checks['cancelled_transfer_allows_rescan']=request('GET','/v1/sync/skills-shared?device=fixture')[0]==200
    status,value=request('PUT','/v1/sync/skills-shared/file?'+cancelled_query,b'x'*size)
    checks['cancelled_transfer_retries_safely']=status==200 and value['ok'] and (cloud/'cancelled').read_bytes()==b'x'*size
    # Recheck admission after receiving a body, not just when HTTP headers arrive.
    attachment=http.client.HTTPConnection(address,timeout=25)
    attachment.putrequest('POST','/v1/sessions/cr_probe/attachments?request_id=raced&name=note.txt&kind=file')
    attachment.putheader('Authorization','Bearer '+TOKEN);attachment.putheader('Content-Length',str(2*1024**2));attachment.endheaders()
    attachment.send(b'x'*1024**2);time.sleep(.2)
    fill();attachment.send(b'x'*1024**2)
    response=attachment.getresponse();response.read();attachment.close()
    checks['attachment_cannot_start_writer_during_pause']=response.status==409 and not Path('/code/project/.cloudroom/attachments/raced/note.txt').exists()
    free()
    status,value=request('POST','/v1/sessions/cr_probe/attachments?request_id=raced&name=note.txt&kind=file',b'x'*(2*1024**2))
    checks['attachment_retry_after_pause']=status==202 and Path(value['receipt']['input']['path']).read_bytes()==b'x'*(2*1024**2)
    # Keep the existing missing-path protection when switching the sampled disk to /code.
    moved=BASE/'moved-home'; (BASE/'home').rename(moved)
    try:
        time.sleep(2)
        checks['missing_monitored_path_blocks']=request('GET','/v1/health')[1]['storage']['reason']=='measurement_unavailable'
    finally:
        moved.rename(BASE/'home')
    free()
    run('mount','-t','tmpfs','-o','size=16m,mode=0700','tmpfs','/code/project')
    try:
        time.sleep(2)
        checks['unmonitored_registered_volume_blocks']=request('GET','/v1/health')[1]['storage']['reason']=='measurement_unavailable'
    finally:
        run('umount','/code/project')
    free()
    print(json.dumps(checks,indent=2),flush=True)
    assert all(checks.values()),checks
finally:
    (BASE/'filler').unlink(missing_ok=True)
    stop()
    for path in BASE.glob('*.log'):
        print('\nLOG '+path.name+'\n'+path.read_text()[-3000:],flush=True)
