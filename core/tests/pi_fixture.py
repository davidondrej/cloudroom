#!/usr/bin/env python3
"""Pi RPC fixture with real owned tools; no model or external credentials."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import uuid

args = sys.argv[1:]
if args == ['--version']:
    print('0.85.1')
    raise SystemExit(0)
path = Path(args[args.index('--session') + 1])
model = args[args.index('--model') + 1]
provider = args[args.index('--provider') + 1]
helper = Path(args[args.index('-e') + 1])
if not path.read_text():
    path.write_text(json.dumps({'type':'session','version':3,'id':str(uuid.uuid4()),'cwd':str(Path.cwd())})+'\n')
native = json.loads(path.read_text().splitlines()[0])['id']
lock = threading.Lock()
running = False
compacting = False
native_queue = False
children = []
held = []
active = None
thinking = 'medium'

def send(value):
    with lock:
        print(json.dumps(value, ensure_ascii=False), flush=True)

def entry(message):
    value = {'type':'message','id':uuid.uuid4().hex[:8],'parentId':None,'message':message}
    with lock:
        with path.open('a') as f:
            f.write(json.dumps(value)+'\n')
    send({'type':'message_end','message':message})

def finish(reason='stop', text='done'):
    global running
    running = False
    entry({'role':'assistant','content':[{'type':'text','text':text}],'stopReason':reason})
    send({'type':'turn_end'})
    send({'type':'agent_end','messages':[],'willRetry':False})
    send({'type':'agent_settled'})

try:
    if Path('startup-delay').exists():
        time.sleep(float(Path('startup-delay').read_text()))
    for line in sys.stdin:
        v = json.loads(line); kind = v['type']; ident = v.get('id'); data = None
        if kind == 'get_state':
            data = {'sessionId':native,'sessionFile':str(path),'model':{'id':model,'provider':provider},'thinkingLevel':thinking,'isStreaming':running,'isCompacting':compacting,'pendingMessageCount':int(native_queue)}
        elif kind == 'get_available_thinking_levels':
            data = {'levels':['off','medium','high']}
        elif kind == 'set_thinking_level':
            assert v['level'] in ['off','medium','high']
            thinking = v['level']
        elif kind == 'get_commands':
            data = {'commands':[{'name':'cloudroom_context','description':'Cloudroom context-only notice (v1)','source':'extension','sourceInfo':{'path':str(helper)}}]}
        elif kind == 'prompt':
            text = v['message']
            if v.get('streamingBehavior') == 'steer':
                if not running:
                    send({'id':ident,'type':'response','command':kind,'success':False,'error':'steer target is no longer active'})
                    continue
                data = {'steered':True}
            elif text.startswith('/cloudroom_context '):
                notice = json.loads(text.split(' ',1)[1])['text']
                if Path('hold-cache').exists():
                    held.append(open(Path('hold-cache').read_text(), 'rb'))
                with Path('warning-'+native).open('a') as warning:
                    warning.write(notice+'\n')
                entry({'role':'custom','customType':'cloudroom_notice','content':notice})
            elif text == '/cloudroom_snapshot':
                pass
            elif text.startswith('/cloudroom_child_result '):
                reply = json.loads(text.split(' ',1)[1])
                assert reply.get('result') == 'done', reply
                Path('child-result').write_text(json.dumps(reply))
                finish()
            elif text == 'reject':
                send({'id':ident,'type':'response','command':kind,'success':False,'error':'rejected before acceptance'})
                continue
            elif text == 'handled':
                pass
            elif text == 'dialog':
                active = ident
                send({'type':'extension_ui_request','id':'dialog','method':'confirm','title':'Approval?'})
                continue
            else:
                if running:
                    raise RuntimeError('Cloudroom dispatched concurrent Pi prompts')
                running = True
                send({'type':'response','id':ident,'command':'prompt','success':True})
                send({'type':'agent_start'})
                content = [{'type':'text','text':text}, *v['images']] if v.get('images') else text
                entry({'role':'user','content':content})
                send({'type':'turn_start'})
                send({'type':'message_start','message':{'role':'assistant','content':[]}})
                if text in ('hold', 'hold-native-queue'):
                    native_queue = text == 'hold-native-queue'
                    code = "from pathlib import Path;import time,os\np=Path("+repr(native+'.ticks')+");Path("+repr(native+'.pid')+").write_text(str(os.getpid()))\nfor n in range(10000):\n p.write_text(str(n));time.sleep(.05)"
                    child = subprocess.Popen([sys.executable,'-c',code],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                    children.append(child)
                    send({'type':'tool_execution_start','toolCallId':'tool-1','toolName':'bash','args':{'command':'fixture'}})
                elif text.startswith('verify attachments\n'):
                    images = [base64.b64decode(image['data'], validate=True) for image in v['images']]
                    files = [Path(line[16:-1]).read_bytes() for line in text.splitlines() if line.startswith('[Attached file: ')]
                    assert len(images) == len(files) == 1
                    proof = 'attachments read: ' + ' '.join(hashlib.sha256(data).hexdigest() for data in images + files)
                    finish(text=proof)
                elif text == 'child':
                    send({'type':'cloudroom_child_request','id':'fixture-child','tool_call_id':'child-tool','prompt':'hello'})
                elif text == 'retry':
                    def retry():
                        global compacting
                        send({'type':'turn_end'})
                        send({'type':'agent_end','willRetry':True})
                        compacting = True
                        send({'type':'compaction_start','reason':'overflow'})
                        send({'type':'agent_settled'})  # A premature signal must not finish busy work.
                        time.sleep(.3)
                        compacting = False
                        send({'type':'compaction_end','willRetry':True})
                        send({'type':'agent_start'})
                        send({'type':'message_update','assistantMessageEvent':{'type':'toolcall_delta','delta':'{'},'usage':{'input':1}})
                        send({'type':'message_update','assistantMessageEvent':{'type':'text_delta','delta':'hi'},'usage':{'input':1}})
                        send({'type':'tool_execution_update','toolCallId':'tool','partialResult':{'content':[{'type':'text','text':'one'}]}})
                        send({'type':'tool_execution_update','toolCallId':'tool','partialResult':{'content':[{'type':'text','text':'one two'}]}})
                        finish()
                    threading.Thread(target=retry,daemon=True).start()
                else:
                    send({'type':'message_update','assistantMessageEvent':{'type':'text_delta','delta':'unicode \u2028 \u2029 héllo'}})
                    finish('error' if text == 'failure' else 'stop')
                continue
        elif kind == 'extension_ui_response':
            assert v.get('cancelled') is True, 'fixture must never be approved'
            send({'type':'response','id':active,'command':'prompt','success':True})
            continue
        elif kind == 'abort':
            if native_queue:
                Path('unwanted-native-continuation').touch()
                native_queue = False
            for child in children:
                if child.poll() is None:
                    child.kill();child.wait()
            if running:
                # Real Pi may abort inside a tool without another assistant message.
                running = False
                entry({'role':'toolResult','toolCallId':'tool-1','isError':True,'content':'Command aborted'})
                send({'type':'agent_end','willRetry':False,'messages':[]})
                send({'type':'agent_settled'})
        elif kind in ('abort_bash','clear_queue'):
            if kind == 'clear_queue': native_queue = False
            data = {'steering':[],'followUp':[]}
        elif kind == 'compact':
            compacting = True
            send({'type':'compaction_start','reason':'manual'})
            compacting = False
            if Path('compact-error').exists():
                send({'type':'compaction_end','reason':'manual','aborted':False,'willRetry':False,'errorMessage':'Nothing to compact (session too small)'})
                send({'type':'response','id':ident,'command':kind,'success':False,'error':'Nothing to compact (session too small)'})
                continue
            send({'type':'compaction_end','willRetry':False})
            data = {}
        elif kind == 'get_fork_messages':
            entries = [json.loads(line) for line in path.read_text().splitlines()]
            data = {'messages':[{'entryId':e['id'],'text':e['message']['content']} for e in entries if e.get('message',{}).get('role') == 'user']}
        elif kind == 'get_last_assistant_text':
            data = {'text':'done'}
        elif kind == 'fork':
            entries = [json.loads(line) for line in path.read_text().splitlines()]
            selected = next((i for i,e in enumerate(entries) if e.get('id') == v.get('entryId') and e.get('message',{}).get('role') == 'user'), None)
            if selected is None:
                send({'type':'response','id':ident,'command':kind,'success':False,'error':'user checkpoint required'})
                continue
            if Path('hold-fork').exists():
                Path('fork-ready').touch()
                while not Path('release-fork').exists(): time.sleep(.01)
            native = str(uuid.uuid4())
            path = path.parent / (native + '.jsonl')
            entries[0]['id'] = native
            path.write_text(''.join(json.dumps(e)+'\n' for e in entries[:selected]))
            data = {'text':entries[selected]['message']['content'],'cancelled':False}
        elif kind == 'get_session_stats':
            data = {'contextUsage':{'tokens':128,'contextWindow':100000},'tokens':{'input':100,'output':28,'cacheRead':0,'cacheWrite':0,'total':128}}
        else:
            raise RuntimeError('unexpected RPC command '+kind)
        send({'type':'response','id':ident,'command':kind,'success':True,**({'data':data} if data is not None else {})})
finally:
    for child in children:
        if child.poll() is None:
            child.kill();child.wait()
