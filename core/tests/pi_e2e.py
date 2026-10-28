"""Real Pi + Rust HTTP, using disposable files and existing credentials. No database changes.
Requires an installed Pi 0.85.1+ and valid credentials. Linux containment/DB upload
remain separate checks; this intentionally exercises local recording during DB outage.
"""
import json
import os
from pathlib import Path
import queue
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time

from core_e2e import ROOT, Service, run, until, wait_done, next_event


def main():
    source = Path(os.environ.get('CLOUDROOM_TEST_PI_HOME',str(Path.home()/'.pi/agent')))
    binary = os.environ.get('CLOUDROOM_TEST_PI_BINARY') or shutil.which('pi')
    provider = os.environ.get('CLOUDROOM_TEST_PI_PROVIDER','openai-codex')
    model = os.environ.get('CLOUDROOM_TEST_PI_MODEL','gpt-6-astra')
    if not binary or not (source/'auth.json').is_file():
        raise SystemExit('BLOCKED: installed Pi and configured test credentials are required')
    auth = json.loads((source/'auth.json').read_text())
    credential = auth.get(provider)
    if not credential:
        raise SystemExit('BLOCKED: selected Pi provider has no saved credential')
    if credential.get('type')=='oauth' and credential.get('expires',0)<(time.time()+900)*1000:
        raise SystemExit('BLOCKED: refresh the selected Pi login normally before testing; this test will not refresh copied OAuth credentials')
    evidence={'provider':provider,'model':model,'checks':[],'limitations':['No PostgreSQL upload or Linux cgroup validation in this script.']}
    def passed(label):evidence['checks'].append(label);print('PASS:',label,flush=True)
    service=None
    try:
        with tempfile.TemporaryDirectory(prefix='cloudroom-real-pi-') as tmp:
            root=Path(tmp).resolve();repo=root/'repo';repo.mkdir();run('git','init','--quiet',str(repo))
            home=root/'home';agent=home/'.pi/agent';agent.mkdir(parents=True)
            (agent/'auth.json').write_text(json.dumps({provider:credential}));(agent/'auth.json').chmod(0o600)
            (agent/'settings.json').write_text(json.dumps({'defaultThinkingLevel':'minimal'}))
            launcher=root/'pi-launcher'
            safe_path=os.pathsep.join(dict.fromkeys([str(Path(shutil.which('node') or '/usr/local/bin/node').parent),'/usr/local/bin','/usr/bin','/bin']))
            launcher.write_text('#!/bin/sh\nexport PATH='+shlex.quote(safe_path)+'\nexec '+shlex.quote(binary)+' "$@" --no-context-files --no-extensions\n');launcher.chmod(0o700)
            native_file=agent/'sessions/seed.jsonl';native_file.parent.mkdir();native_file.touch()
            env={'PATH':safe_path,'HOME':str(home),'PI_CODING_AGENT_DIR':str(agent),'PI_OFFLINE':'1','PI_TELEMETRY':'0'}
            # Create the native session through Pi itself, without a model prompt.
            child=subprocess.Popen([str(launcher),'--mode','rpc','--session',str(native_file),'--provider',provider,'--model',model,'-e',str(ROOT/'src/runtime/pi-context.ts')],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
            lines=queue.Queue()
            def read():
                for line in child.stdout:lines.put(json.loads(line))
            threading.Thread(target=read,daemon=True).start()
            seen = []
            def rpc(kind, **fields):
                child.stdin.write((json.dumps({'type':kind,'id':kind,**fields})+'\n').encode());child.stdin.flush()
                while True:
                    message=lines.get(timeout=30);seen.append(message)
                    if message.get('id')==kind:
                        assert message['success']
                        return message.get('data')
            try:
                native=rpc('get_state')['sessionId']
                assert any(c['name']=='cloudroom_context' for c in rpc('get_commands')['commands'])
                notice='Cloudroom synthetic storage notice; no extra task.'
                rpc('prompt',message='/cloudroom_context '+json.dumps({'text':notice}))
                assert any(m.get('customType')=='cloudroom_notice' and m['content']==notice for m in rpc('get_messages')['messages'])
                assert rpc('get_state')['isStreaming'] is False
                assert not any(m.get('type')=='agent_start' for m in seen)
                passed('real Pi context-only notice persists without an extra model run')
                child.stdin.close();child.wait(timeout=8)
            finally:
                if child.poll() is None:child.kill();child.wait()
            state=root/'state';state.mkdir()
            records=[('receipt',{'request_id':'pi','command':'start','input':{'harness':'pi'},'state':'completed'}),('native_identity',{'id':native,'path':str(native_file),'model':model,'provider':provider}),('state',{'state':'idle'})]
            for n,(kind,data) in enumerate(records,1):
                (state/f'{n:020}.record').write_text(json.dumps({'sequence':n,'session_id':'cr_pi','kind':kind,'data':data}))
            core={
                'PATH':safe_path,'CLOUDROOM_TOKEN':secrets.token_hex(32),'CLOUDROOM_LISTEN':'127.0.0.1:0',
                'CLOUDROOM_STATE_DIR':str(state),'CLOUDROOM_REPOSITORY':str(repo),'CLOUDROOM_ACCOUNT_HOME':str(home),
                'CLOUDROOM_HARNESS':'pi','CLOUDROOM_PI_BINARY':str(launcher),'CLOUDROOM_PI_HOME':str(agent),
                'CLOUDROOM_PI_MODEL':model,'CLOUDROOM_PI_PROVIDER':provider,'CLOUDROOM_LOCAL_HISTORY':'1',
                'CLOUDROOM_STORE':'real-pi-test','CLOUDROOM_UNPROTECTED_TEST_MODE':'1',
            }
            service=Service(core,root/'service.log').start()
            until(lambda:service.session('cr_pi')['state']=='idle','real Pi resume',40)
            assert service.session('cr_pi')['native_id']==native
            passed('Pi-only configuration and same native session resume through Rust')
            for token in [None,'wrong']:service.request('GET','/v1/health',token=token,expected=401)
            passed('authentication rejects missing/wrong tokens')
            body={'request_id':'write','text':'Use bash to append exactly first and a newline to counter.txt. Never overwrite it. Read the file and reply READY. Do not spawn agents or use the network.'}
            service.request('POST','/v1/sessions/cr_pi/prompts',body,202)
            service.request('POST','/v1/sessions/cr_pi/prompts',body,202)
            service.request('POST','/v1/sessions/cr_pi/prompts',{**body,'text':'different'},409)
            wait_done(service,'cr_pi','write')
            assert (repo/'counter.txt').read_text()=='first\n'
            passed('real tool execution, safe retry and conflicting request rejection')
            records=service.records('cr_pi')
            assert any(r['kind']=='item_completed' for r in records)
            assert any(r['kind']=='text_delta' for r in records)
            until(lambda:b''.join(r['native'].encode() for r in service.records('cr_pi') if r['kind']=='native_record')==native_file.read_bytes(),'exact native archive',15)
            passed('streaming text/tool output and byte-for-byte native history')
            connection,response=service.stream('cr_pi',records[-2]['sequence'])
            try:assert next_event(response)==records[-1]
            finally:response.close();connection.close()
            passed('reconnect replays the same saved event')
            assert service.request('GET','/v1/health')['saving']['pending_records']>0
            passed('work and local recording continue with PostgreSQL unavailable')
            (repo/'job.py').write_text("from pathlib import Path;import time,os\nPath('job.pid').write_text(str(os.getpid()))\nfor n in range(600):\n Path('job.ticks').write_text(str(n));time.sleep(.1)\n")
            service.request('POST','/v1/sessions/cr_pi/prompts',{'request_id':'long','text':'Run exactly python3 job.py in the foreground and wait. Do not edit files, spawn agents or run other commands.'},202)
            until(lambda:(repo/'job.ticks').exists(),'real long-running Pi tool')
            queued={'request_id':'queued','text':'Use bash to append exactly second and a newline to counter.txt once. Do not overwrite it. Do not spawn agents or do other work.'}
            service.request('POST','/v1/sessions/cr_pi/prompts',queued,202)
            assert service.session('cr_pi')['queue']==['queued']
            service.request('POST','/v1/sessions/cr_pi/interrupt',{'request_id':'stop','target_request_id':'long'},202)
            until(lambda:service.session('cr_pi')['receipts']['stop']['state']=='completed','real Pi abort')
            until(lambda:service.session('cr_pi')['receipts']['long']['state']=='interrupted','interrupted request')
            ticks=(repo/'job.ticks').read_text();time.sleep(.4);assert (repo/'job.ticks').read_text()==ticks
            wait_done(service,'cr_pi','queued')
            assert (repo/'counter.txt').read_text()=='first\nsecond\n'
            passed('busy queue, real tool interruption and queued continuation without replay')
            service.stop();service.start()
            until(lambda:service.session('cr_pi')['state']=='idle','resume after graceful restart',40)
            assert service.session('cr_pi')['native_id']==native
            assert service.request('POST','/v1/sessions/cr_pi/prompts',queued,202)['receipt']['state']=='completed'
            passed('restart preserves native identity and settled receipts')
            service.request('POST','/v1/sessions/cr_pi/close',{'request_id':'close'},202)
            until(lambda:service.session('cr_pi')['state']=='closed','real Pi close',8)
            service.stop();service.start();assert service.session('cr_pi')['state']=='closed'
            passed('close is durable and never revived')
    finally:
        if service:service.stop()
        evidence_file=ROOT/'private/pi-e2e-last.json';evidence_file.parent.mkdir(exist_ok=True)
        evidence_file.write_text(json.dumps(evidence,indent=2)+'\n')

def native_fixture():
    """Real installed Pi/tool/fork lifecycle with scripted inference, no credentials."""
    from core_fixture import ReplayTests
    binary = shutil.which('pi')
    node = shutil.which('node')
    if not binary or not node:
        raise SystemExit('BLOCKED: installed Pi 0.85.1+ and Node are required')
    test = ReplayTests(); test.setUp()
    try:
        home = test.root / 'pi'
        (home / 'sessions').mkdir(parents=True)
        provider = test.root / 'provider.ts'
        provider.write_text('''
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
export default function(pi) {
  pi.registerProvider('cloudroom-fixture', {
    api: 'cloudroom-fixture', baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic-not-a-credential',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const user = context.messages.filter(m => m.role === 'user').at(-1);
      const text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
      const child = context.messages.find(m => m.role === 'toolResult' && m.toolName === 'cloudroom_subagent');
      const delegate = text?.includes('PARENT_TASK') && !child;
      const message = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: delegate ? [{ type: 'toolCall', id: 'fixture-call', name: 'cloudroom_subagent', arguments: { prompt: 'CHILD_TASK' } }] : [{ type: 'text', text: child ? 'PARENT_RECEIVED_CHILD: ' + JSON.stringify(child.content) : 'CHILD_RESULT' }],
        stopReason: delegate ? 'toolUse' : 'stop',
        usage: { input: 128, output: 16, cacheRead: 0, cacheWrite: 0, totalTokens: 144, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); });
      return stream;
    },
  });
}
''')
        wrapper = test.root / 'pi-wrapper'
        safe_path = str(Path(node).parent) + ':/usr/local/bin:/usr/bin:/bin'
        wrapper.write_text('#!/bin/sh\nexport PATH=' + shlex.quote(safe_path) + '\nexec ' + shlex.quote(binary) + ' "$@" --no-context-files --no-extensions -e ' + shlex.quote(str(provider)) + '\n')
        wrapper.chmod(0o700)
        native = home / 'sessions/seed.jsonl'
        native.write_text(json.dumps({'type':'session','version':3,'id':'synthetic-parent','cwd':str(test.repo),'timestamp':'2026-09-18T00:00:00Z'}) + '\n')
        records = [('receipt',{'request_id':'pi','command':'start','input':{'harness':'pi'},'state':'completed','model':'fixture','provider':'cloudroom-fixture'}),('native_identity',{'id':'synthetic-parent','path':str(native)}),('state',{'state':'idle'})]
        for i,(kind,data) in enumerate(records,1):
            (test.state/f'{i:020}.record').write_text(json.dumps({'sequence':i,'session_id':'cr_pi','kind':kind,'data':data}))
        test.env.update(CLOUDROOM_PI_HOME=str(home), CLOUDROOM_PI_BINARY=str(wrapper), CLOUDROOM_PI_PROVIDER='cloudroom-fixture', CLOUDROOM_PI_MODEL='fixture')
        test.start()
        service = test.service
        until(lambda: service.session('cr_pi')['state'] == 'idle', 'real Pi ready', 30)
        service.request('POST','/v1/sessions/cr_pi/prompts',{'request_id':'parent','text':'PARENT_TASK'},202)
        until(lambda: service.session('cr_pi')['receipts']['parent']['state'] == 'completed', 'real Pi parent/child', 30)
        records = service.records('cr_pi')
        links = [r['data'] for r in records if r['kind'] == 'child']
        assert [r['state'] for r in links] == ['started','completed'], links
        assert service.session(links[0]['id'])['parent_session'] == 'cr_pi'
        assert any('PARENT_RECEIVED_CHILD' in r.get('native','') for r in records)
        print('PASS: real Pi tool executes through a core-owned child and receives its result')
        checkpoint = next(r['data']['id'] for r in records if r['kind'] == 'checkpoint' and r['data']['request_id'] == 'parent')
        body = {'request_id':'rewind','before':checkpoint,'replacement':{'request_id':'corrected','text':'CORRECTED_TASK'}}
        service.request('POST','/v1/sessions/cr_pi/rewind',body,202)
        until(lambda: service.session('cr_pi')['receipts'].get('corrected',{}).get('state') == 'completed', 'real Pi replacement', 30)
        session = service.session('cr_pi')
        fork = Path(session['native_path'])
        assert fork != native
        raw = fork.read_text()
        assert 'CORRECTED_TASK' in raw and 'PARENT_TASK' not in raw and 'PARENT_RECEIVED_CHILD' not in raw
        print('PASS: native empty fork is durable and excludes discarded context')
        until(lambda: any(r['kind']=='usage' and r['data'].get('contextUsage',{}).get('tokens') is not None for r in service.records('cr_pi')), 'native context usage', 5)
        saved = service.records('cr_pi')
        service.stop(); service.start()
        until(lambda: service.session('cr_pi')['state'] == 'idle', 'native fork restart', 30)
        assert service.session('cr_pi')['native_id'] == session['native_id']
        assert service.records('cr_pi')[:len(saved)] == saved
        service.request('POST','/v1/sessions/cr_pi/rewind',body,202)
        assert fork.read_text().count('CORRECTED_TASK') == 1
        print('PASS: context usage, replay and exactly-once replacement survive restart')
    finally:
        test.tearDown()


if __name__=='__main__':
    native_fixture() if sys.argv[1:] == ['--fixture'] else main()
