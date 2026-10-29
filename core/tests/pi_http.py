"""Shared Rust HTTP lifecycle with mixed Codex/Pi protocol fixtures and no database."""
import json
from pathlib import Path
import time
import unittest

import core_fixture
from core_e2e import Service, until, next_event

class MixedHarnessTests(unittest.TestCase):
    tearDown, start = core_fixture.ReplayTests.tearDown, core_fixture.ReplayTests.start

    def setUp(self):
        core_fixture.ReplayTests.setUp(self)
        home = self.root / 'pi-home'
        home.mkdir()
        self.env.update(CLOUDROOM_PI_HOME=str(home), CLOUDROOM_PI_BINARY=str(Path(__file__).with_name('pi_fixture.py').resolve()), CLOUDROOM_PI_MODEL='fixture', CLOUDROOM_PI_PROVIDER='fixture')
        sequence = 0
        for kind in ['codex','pi']:
            native = kind+'-native'
            directory = Path(self.env['CLOUDROOM_'+kind.upper()+'_HOME'])/'sessions'
            directory.mkdir()
            path = directory/(native+'.jsonl')
            path.write_text(json.dumps({'type':'session','version':3,'id':native,'cwd':str(self.repo.resolve())})+'\n' if kind=='pi' else '{"fixture":"seed"}\n')
            records = [('receipt',{'request_id':kind,'command':'start','input':{'harness':'pi'} if kind=='pi' else {},'state':'completed'}),('native_identity',{'id':native,'path':str(path)}),('state',{'state':'idle'})]
            for name,data in records:
                sequence += 1
                (self.state/f'{sequence:020}.record').write_text(json.dumps({'sequence':sequence,'session_id':'cr_'+kind,'kind':name,'data':data}))
        self.start()
        for kind in ['codex','pi']:
            until(lambda:self.service.session('cr_'+kind)['state']=='idle','ready '+kind,10)

    def send(self,kind,key,text):
        return self.service.request('POST',f'/v1/sessions/cr_{kind}/prompts',{'request_id':key,'text':text},202)

    def settled(self,kind,key,state='completed'):
        until(lambda:self.service.session('cr_'+kind)['receipts'][key]['state']==state,'settled '+key,10)

    def test_slow_native_startup_keeps_identity_and_queued_work(self):
        self.send('pi','before-slow-restart','hello'); self.settled('pi','before-slow-restart')
        native = self.service.session('cr_pi')['native_id']
        self.service.stop()
        # 2s RPC and 8s startup deadlines: this startup outlasts an ordinary RPC but not startup.
        self.env.update(CLOUDROOM_TEST_RPC_TIMEOUT_MS='2000')
        (self.repo/'startup-delay').write_text('4')
        self.start()
        self.send('pi','during-startup','hello')
        until(lambda:self.service.session('cr_pi')['receipts']['during-startup']['state']=='completed','slow startup continuation',20)
        session = self.service.session('cr_pi')
        self.assertEqual(session['native_id'],native)
        self.assertEqual(session['queue'],[])
        users = [json.loads(line)['message']['content'] for line in Path(session['native_path']).read_text().splitlines() if json.loads(line).get('message',{}).get('role')=='user']
        self.assertEqual(users,['hello','hello'])
        self.assertEqual(self.service.session('cr_codex')['state'],'idle')

    def test_startup_timeout_preserves_queue_until_explicit_retry(self):
        self.send('pi','original','hello'); self.settled('pi','original')
        native = self.service.session('cr_pi')['native_id']
        self.env.update(CLOUDROOM_TEST_RPC_TIMEOUT_MS='2000')  # 8s startup deadline.
        self.service.stop(); (self.repo/'startup-delay').write_text('121'); self.start()
        self.send('pi','waiting','hello')
        until(lambda:self.service.session('cr_pi').get('startup_error')=='startup_timeout','classified startup timeout',30)
        self.assertEqual(self.service.session('cr_pi')['queue'],['waiting'])
        self.service.stop(); (self.repo/'startup-delay').unlink(); self.start()
        failed = self.service.session('cr_pi')
        self.assertEqual(failed['state'],'process_lost')
        self.assertEqual(failed['queue'],['waiting'])
        self.assertEqual(failed['receipts']['waiting']['state'],'accepted')
        self.service.request('POST','/v1/sessions/cr_pi/resume',{'request_id':'explicit-retry'},202)
        self.settled('pi','waiting'); self.settled('pi','explicit-retry')
        self.service.request('POST','/v1/sessions/cr_pi/resume',{'request_id':'explicit-retry'},202)
        self.assertEqual(self.service.session('cr_pi')['native_id'],native)
        users = [json.loads(line)['message']['content'] for line in Path(self.service.session('cr_pi')['native_path']).read_text().splitlines() if json.loads(line).get('message',{}).get('role')=='user']
        self.assertEqual(users,['hello','hello'])

    def test_same_api_queue_interrupt_replay_and_restart(self):
        for kind in ['codex','pi']:
            self.assertEqual(self.service.request('POST','/v1/sessions',{'request_id':kind,'harness':kind},202)['session_id'],'cr_'+kind)
            self.service.request('POST','/v1/sessions',{'request_id':kind,'harness':'pi' if kind=='codex' else 'codex'},409)
            self.send(kind,'active','hold')
        until(lambda:(self.repo/'pi-native.ticks').exists() and (self.repo/'codex-native.ticks').exists(),'both tools active',8)
        for kind in ['codex','pi']:
            for key in ['queued-a','queued-b']:
                self.send(kind,key,'hello')
            self.send(kind,'queued-a','hello')
            self.service.request('POST',f'/v1/sessions/cr_{kind}/prompts',{'request_id':'queued-a','text':'different'},409)
            self.assertEqual(self.service.session('cr_'+kind)['queue'],['queued-a','queued-b'])
        before=(self.repo/'codex-native.ticks').read_text()
        self.service.request('POST','/v1/sessions/cr_pi/interrupt',{'request_id':'stop','target_request_id':'active'},202)
        self.settled('pi','active','interrupted');self.settled('pi','queued-b')
        time.sleep(.2)
        self.assertNotEqual((self.repo/'codex-native.ticks').read_text(),before)
        self.service.request('POST','/v1/sessions/cr_codex/interrupt',{'request_id':'stop','target_request_id':'active'},202)
        self.settled('codex','active','interrupted');self.settled('codex','queued-b')
        for kind in ['codex','pi']:
            records=self.service.records('cr_'+kind)
            order=[r['data']['request_id'] for r in records if r['kind']=='state' and r['data'].get('state')=='starting_turn']
            self.assertEqual(order,['active','queued-a','queued-b'])
            connection,response=self.service.stream('cr_'+kind,records[-2]['sequence'])
            try:self.assertEqual(next_event(response),records[-1])
            finally:response.close();connection.close()
        self.service.stop();self.start()
        for kind in ['codex','pi']:
            until(lambda:self.service.session('cr_'+kind)['state']=='idle','resume '+kind,10)
            self.assertEqual(self.service.session('cr_'+kind)['native_id'],kind+'-native')
            self.send(kind,'after-restart','hello');self.settled(kind,'after-restart')
        dashboard=self.service.request('GET','/v1/dashboard')
        self.assertEqual({s['harness'] for s in dashboard['sessions']},{'codex','pi'})

    def test_pi_images_cannot_read_outside_workspace_and_rejection_releases_queue(self):
        import base64
        secret = self.root / 'service-secret'
        secret.write_bytes(b'SYNTHETIC_SERVICE_SECRET_NOT_AN_IMAGE')
        linked = self.repo / 'linked.png'; linked.symlink_to(secret)
        import os
        fifo = self.repo / 'fifo.png'; os.mkfifo(fifo)
        large = self.repo / 'large.png'
        with large.open('wb') as output: output.truncate(10 * 1024 * 1024 + 1)
        frame = self.repo / 'frame.png'
        with frame.open('wb') as output: output.truncate(6 * 1024 * 1024)
        for key, fields in [
            ('direct', {'attachments':[{'kind':'image','path':str(secret)}]}),
            ('linked', {'content':[{'type':'localImage','path':str(linked)}]}),
            ('missing', {'attachments':[{'kind':'image','path':str(self.repo/'missing.png')}]}),
            ('fifo', {'attachments':[{'kind':'image','path':str(fifo)}]}),
            ('large', {'attachments':[{'kind':'image','path':str(large)}]}),
            ('frame', {'attachments':[{'kind':'image','path':str(frame)}] * 2}),
        ]:
            self.service.request('POST','/v1/sessions/cr_pi/prompts',{'request_id':key,'text':'inspect',**fields},202)
            until(lambda:self.service.session('cr_pi')['receipts'][key]['state'] in ['failed','completed'],key,10)
            records = json.dumps(self.service.records('cr_pi'))
            self.assertNotIn(base64.b64encode(secret.read_bytes()).decode(), records, 'protected bytes reached Pi/history')
            self.settled('pi',key,'failed')
            self.send('pi','after-'+key,'hello'); self.settled('pi','after-'+key)
        image = self.repo / 'allowed.png'; image.write_bytes(b'\x89PNG\r\n\x1a\nfixture')
        second = self.repo / 'second.png'; second.write_bytes(b'\x89PNG\r\n\x1a\nsecond fixture')
        self.service.request('POST','/v1/sessions/cr_pi/prompts',{
            'request_id':'allowed','text':'inspect','attachments':[{'kind':'image','path':str(p)} for p in [image,second]]},202)
        self.settled('pi','allowed')
        for path in [image,second]:
            self.assertIn(base64.b64encode(path.read_bytes()).decode(),json.dumps(self.service.records('cr_pi')))

    def test_pi_thinking_selection_survives_restart_and_preserves_request_identity(self):
        self.service.stop()
        path = self.state / '00000000000000000004.record'
        record = json.loads(path.read_text())
        self.assertEqual(record['data']['request_id'], 'pi')
        record['data']['input']['reasoning'] = 'high'
        path.write_text(json.dumps(record))
        (self.state / 'snapshot.json').unlink()  # Core trusts its snapshot over edited old records.
        self.start()
        until(lambda:self.service.session('cr_pi')['state']=='idle','Pi with selected thinking',10)
        self.assertEqual(self.service.session('cr_pi')['reasoning'], 'high')
        self.service.request('POST','/v1/sessions',{'request_id':'pi','harness':'pi','reasoning':'high'},202)
        self.service.request('POST','/v1/sessions',{'request_id':'pi','harness':'pi','reasoning':'medium'},409)
        frames=[json.loads(r['native']) for r in self.service.records('cr_pi') if r.get('native') and r['kind']!='native_record']
        self.assertTrue(any(f.get('command')=='get_state' and f.get('data',{}).get('thinkingLevel')=='high' for f in frames))
        self.send('pi','thinking-check','hello');self.settled('pi','thinking-check')
        self.service.stop();self.start()
        until(lambda:self.service.session('cr_pi')['state']=='idle','Pi thinking after restart',10)
        self.assertEqual(self.service.session('cr_pi')['reasoning'], 'high')

    def test_interrupt_clears_pi_internal_continuations_not_cloudroom_queue(self):
        self.send('pi','active','hold-native-queue')
        until(lambda:(self.repo/'pi-native.ticks').exists(),'native tool with internal queue',5)
        self.send('pi','next-user-request','hello')
        self.service.request('POST','/v1/sessions/cr_pi/interrupt',{'request_id':'stop','target_request_id':'active'},202)
        self.settled('pi','active','interrupted')
        self.settled('pi','next-user-request')
        self.assertFalse((self.repo/'unwanted-native-continuation').exists())

    def test_pi_session_pipe_cannot_block_startup_or_other_sessions(self):
        import os
        native_path = Path(self.service.session('cr_pi')['native_path'])
        self.service.stop()
        native_path.unlink(); os.mkfifo(native_path)
        # Bound startup even before signal handlers exist; the old code hangs in open().
        self.service = Service(self.env, self.root/'pipe.log')
        try:
            self.service.start()
            self.assertEqual(self.service.session('cr_pi')['state'],'process_lost')
            until(lambda:self.service.session('cr_codex')['state']=='idle','Codex remains usable',10)
            self.send('codex','after-pipe','hello'); self.settled('codex','after-pipe')
        except BaseException:
            self.service.stop(crash=True)
            raise

    def test_missing_pi_file_keeps_history_and_other_harness_available(self):
        native_path = Path(self.service.session('cr_pi')['native_path'])
        self.service.stop()
        native_path.unlink()
        self.start()
        self.assertEqual(self.service.session('cr_pi')['state'], 'process_lost')
        self.assertTrue(self.service.records('cr_pi'))
        self.assertFalse(native_path.exists())
        until(lambda:self.service.session('cr_codex')['state']=='idle','Codex survives unrelated native loss',10)
        self.send('codex','unaffected','hello');self.settled('codex','unaffected')

    def test_compaction_settles_before_queued_work_and_reports_failure(self):
        for outcome in ['completed', 'failed', 'interrupted', 'legacy', 'reject']:
            with self.subTest(codex=outcome):
                (self.repo/'compact-mode').write_text(outcome)
                for name in ['compact-ready', 'release-compact']: (self.repo/name).unlink(missing_ok=True)
                request = 'compact-'+outcome
                self.service.request('POST','/v1/sessions/cr_codex/compact',{'request_id':request},202)
                if outcome not in ['legacy', 'reject']:
                    until(lambda:(self.repo/'compact-ready').exists(),'compaction started',5)
                    self.send('codex','after-'+outcome,'hello')
                    time.sleep(.1)
                    pending = self.service.session('cr_codex')
                    self.assertTrue(pending['compacting'])
                    self.assertEqual(pending['state'],'running')
                    self.assertEqual(pending['receipts']['after-'+outcome]['state'],'accepted')
                    for action in ['stop','resume']:
                        self.service.request('POST','/v1/sessions/cr_codex/'+action,{'request_id':action+'-'+outcome},202)
                    self.assertEqual(self.service.session('cr_codex')['receipts']['after-'+outcome]['state'],'accepted')
                    self.assertEqual(self.service.session('cr_codex')['state'],'running')
                    (self.repo/'release-compact').touch()
                else:
                    self.send('codex','after-'+outcome,'hello')
                self.settled('codex',request,{'legacy':'completed','reject':'failed'}.get(outcome,outcome))
                self.settled('codex','after-'+outcome)
                session = self.service.session('cr_codex')
                self.assertFalse(session['compacting'])
                self.assertEqual(session['queue'],[])
                dispatches = (self.repo/'codex-native.requests').read_text().splitlines()
                self.assertEqual(dispatches.count('after-'+outcome),1)
        for failure in [False, True]:
            if failure: (self.repo/'compact-error').touch()
            request = 'pi-compact-'+str(failure)
            self.service.request('POST','/v1/sessions/cr_pi/compact',{'request_id':request},202)
            self.send('pi','after-'+request,'hello')
            self.settled('pi',request,'failed' if failure else 'completed')
            self.settled('pi','after-'+request)
            self.assertFalse(self.service.session('cr_pi')['compacting'])
            if failure: self.assertIn('error',self.service.session('cr_pi')['receipts'][request])

    def test_pi_no_run_input_retry_compaction_and_close(self):
        for text in ['handled','dialog','retry','failure','reject']:
            self.send('pi',text,text)
            self.settled('pi',text,'failed' if text in ['failure','reject'] else 'completed')
        self.assertEqual(self.service.session('cr_pi')['receipts']['reject'].get('error'),
                         'Pi rejected the prompt command: rejected before acceptance')
        self.send('pi','hold','hold')
        until(lambda:(self.repo/'pi-native.ticks').exists(),'tool before close',5)
        self.send('pi','must-not-run','hello')
        self.service.request('POST','/v1/sessions/cr_pi/close',{'request_id':'close'},202)
        until(lambda:self.service.session('cr_pi')['state']=='closed','closed',7)
        self.settled('pi','must-not-run','failed')
        before=(self.repo/'pi-native.ticks').read_text();time.sleep(.2)
        self.assertEqual((self.repo/'pi-native.ticks').read_text(),before)
        self.service.stop();self.start()
        self.assertEqual(self.service.session('cr_pi')['state'],'closed')

    def prompt(self, kind, key, text, reasoning=None, status=202):
        body = {'request_id': key, 'text': text}
        if reasoning is not None:
            body['reasoning'] = reasoning
        return self.service.request('POST', f'/v1/sessions/cr_{kind}/prompts', body, status)

    def test_follow_up_reasoning_keeps_the_same_session(self):
        self.service.stop()
        for sequence in (1, 4):
            path = self.state / f'{sequence:020}.record'
            record = json.loads(path.read_text())
            record['data']['input']['reasoning'] = 'high'
            path.write_text(json.dumps(record))
        (self.state / 'snapshot.json').unlink()  # Core trusts its snapshot over edited old records.
        self.start()
        for kind in ['codex', 'pi']:
            until(lambda kind=kind: self.service.session('cr_'+kind)['state'] == 'idle' and self.service.session('cr_'+kind)['reasoning'] == 'high', 'launch '+kind, 10)
        before = {kind: (self.service.session('cr_'+kind)['session_id'], self.service.session('cr_'+kind)['native_id']) for kind in ['codex', 'pi']}
        self.prompt('codex', 'bad', 'no', 'ultra', 409)
        self.prompt('codex', 'busy', 'hold', 'max')
        until(lambda: (self.repo / 'codex-native.ticks').exists(), 'codex hold', 8)
        self.prompt('codex', 'queued-low', 'one', 'low')
        self.prompt('codex', 'queued-xhigh', 'two', 'xhigh')
        self.prompt('codex', 'queued-low', 'one', 'low')
        self.prompt('codex', 'queued-low', 'one', 'high', 409)
        codex = self.service.session('cr_codex')
        self.assertEqual(codex['queue'], ['queued-low', 'queued-xhigh'])
        self.assertEqual(codex['receipts']['busy']['input']['reasoning'], 'max')
        self.assertEqual(codex['receipts']['queued-low']['input']['reasoning'], 'low')
        self.assertEqual(codex['receipts']['queued-xhigh']['input']['reasoning'], 'xhigh')
        self.assertEqual(codex['reasoning'], 'high')
        self.service.request('POST', '/v1/sessions/cr_codex/interrupt', {'request_id': 'stop-codex', 'target_request_id': 'busy'}, 202)
        self.settled('codex', 'busy', 'interrupted')
        self.settled('codex', 'queued-xhigh')
        self.prompt('codex', 'plain', 'later')
        self.settled('codex', 'plain')
        efforts = [json.loads(line).get('reasoning') for line in (Path(self.env['CLOUDROOM_CODEX_HOME']) / 'sessions' / 'codex-native.jsonl').read_text().splitlines() if '"turn"' in line]
        self.assertEqual(efforts, ['max', 'low', 'xhigh', 'high'])
        self.prompt('pi', 'busy', 'hold', 'medium')
        until(lambda: (self.repo / 'pi-native.ticks').exists(), 'pi hold', 8)
        self.prompt('pi', 'queued-high', 'one', 'high')
        self.prompt('pi', 'unsupported', 'no', 'minimal')
        self.prompt('pi', 'queued-high', 'one', 'medium', 409)
        pi = self.service.session('cr_pi')
        self.assertEqual(pi['queue'], ['queued-high', 'unsupported'])
        self.assertEqual(pi['receipts']['busy']['input']['reasoning'], 'medium')
        self.assertEqual(pi['reasoning'], 'high')
        self.service.request('POST', '/v1/sessions/cr_pi/interrupt', {'request_id': 'stop-pi', 'target_request_id': 'busy'}, 202)
        self.settled('pi', 'busy', 'interrupted')
        self.settled('pi', 'unsupported', 'failed')
        self.assertIn('thinking level', self.service.session('cr_pi')['receipts']['unsupported'].get('error', ''))
        self.prompt('pi', 'plain', 'later')
        self.settled('pi', 'plain')
        levels = [level for record in self.service.records('cr_pi') if record.get('native') if (level := json.loads(record['native']).get('data', {}).get('thinkingLevel'))]
        self.assertIn('medium', levels)
        self.assertEqual(levels[-1], 'high')
        for kind in ['codex', 'pi']:
            session = self.service.session('cr_'+kind)
            self.assertEqual((session['session_id'], session['native_id']), before[kind])
            self.assertEqual(session['reasoning'], 'high')
            self.assertEqual(session['state'], 'idle')

    def test_pi_child_is_core_owned_and_replayed_without_a_gui(self):
        self.send('pi', 'parent', 'child')
        self.settled('pi', 'parent')
        reply = json.loads((self.repo / 'child-result').read_text())
        child = self.service.session(reply['session_id'])
        self.assertEqual(child['parent_session'], 'cr_pi')
        self.assertEqual(child['receipts']['task_fixture-child']['state'], 'completed')
        self.assertEqual(child['receipts']['child_fixture-child']['provider'], 'fixture')
        records = self.service.records(reply['session_id'])
        self.assertTrue(any(r['kind'] == 'harness' for r in records))
        self.assertTrue(any(r['kind'] == 'native_event' for r in records))
        links = [r['data'] for r in self.service.records('cr_pi') if r['kind'] == 'child']
        self.assertEqual([r['state'] for r in links], ['started', 'completed'])
        self.assertEqual(links[-1]['result']['result'], 'done')
        self.service.stop(); self.start()
        until(lambda: self.service.session(reply['session_id'])['state'] == 'idle', 'child resume', 10)
        self.assertEqual(self.service.session(reply['session_id'])['parent_session'], 'cr_pi')
        self.assertEqual([r['data'] for r in self.service.records('cr_pi') if r['kind'] == 'child'], links)

    def test_pi_rewind_uses_user_checkpoint_and_restores_usage(self):
        self.send('pi', 'original', 'hello'); self.settled('pi', 'original')
        until(lambda: any(r['kind'] == 'checkpoint' for r in self.service.records('cr_pi')), 'user checkpoint', 5)
        checkpoint = next(r['data']['id'] for r in self.service.records('cr_pi') if r['kind'] == 'checkpoint')
        original_path = Path(self.service.session('cr_pi')['native_path'])
        entry = next(json.loads(line) for line in original_path.read_text().splitlines() if json.loads(line).get('id') == checkpoint)
        self.assertEqual(entry['message']['role'], 'user')
        body = {'request_id':'rewind','before':checkpoint,'replacement':{'request_id':'corrected','text':'hello'}}
        self.service.request('POST','/v1/sessions/cr_pi/rewind',body,202)
        until(lambda: self.service.session('cr_pi')['receipts'].get('corrected',{}).get('state') == 'completed', 'corrected Pi turn', 10)
        session = self.service.session('cr_pi')
        self.assertNotEqual(Path(session['native_path']), original_path)
        users = [json.loads(line)['message']['content'] for line in Path(session['native_path']).read_text().splitlines() if json.loads(line).get('message',{}).get('role') == 'user']
        self.assertEqual(users, ['hello'])
        until(lambda: any(r['kind'] == 'usage' and r['data'].get('contextUsage',{}).get('tokens') == 128 for r in self.service.records('cr_pi')), 'native usage', 5)
        self.service.stop(); self.start()
        until(lambda: self.service.session('cr_pi')['state'] == 'idle', 'rewind resume', 10)
        self.assertEqual(self.service.session('cr_pi')['native_id'], session['native_id'])
        self.service.request('POST','/v1/sessions/cr_pi/rewind',body,202)
        self.assertEqual(self.service.session('cr_pi')['receipts']['corrected']['state'], 'completed')

    def test_omitted_pi_message_restores_the_launch_default(self):
        until(lambda: self.service.session('cr_pi')['reasoning'] == 'medium', 'captured Pi default', 10)
        self.prompt('pi', 'override', 'hello', 'high')
        self.settled('pi', 'override')
        self.prompt('pi', 'restore', 'again')
        self.settled('pi', 'restore')
        self.assertEqual(self.service.session('cr_pi')['reasoning'], 'medium')
        self.assertEqual(self.service.session('cr_pi')['native_id'], 'pi-native')
        levels = [level for record in self.service.records('cr_pi') if record.get('native') if (level := json.loads(record['native']).get('data', {}).get('thinkingLevel'))]
        self.assertIn('high', levels)
        self.assertEqual(levels[-1], 'medium')

    def test_fresh_pi_start_keeps_the_captured_default(self):
        # A completed seed never finishes its start receipt. Start a real session instead.
        self.service.stop()
        from fake_api import FakeApi
        api = FakeApi(self.env['CLOUDROOM_TOKEN'], 'cloudroom-pi-default')
        try:
            self.env.pop('CLOUDROOM_LOCAL_HISTORY', None)
            self.env.update(api.env())
            self.service = Service(self.env, self.root / 'fresh.log')
            self.service.start()
            sid = self.service.request('POST', '/v1/sessions', {'request_id': 'fresh', 'harness': 'pi'}, 202)['session_id']
            until(lambda: self.service.session(sid)['state'] == 'idle' and self.service.session(sid).get('reasoning') == 'medium', 'fresh default captured', 15)
            started = self.service.session(sid)
            self.assertEqual(started['receipts']['fresh']['state'], 'completed')
            self.assertNotIn('reasoning', started['receipts']['fresh']['input'])
            native = started['native_id']
            self.service.request('POST', f'/v1/sessions/{sid}/prompts', {'request_id': 'up', 'text': 'hello', 'reasoning': 'high'}, 202)
            until(lambda: self.service.session(sid)['receipts']['up']['state'] == 'completed', 'override done', 10)
            self.service.request('POST', f'/v1/sessions/{sid}/prompts', {'request_id': 'back', 'text': 'again'}, 202)
            until(lambda: self.service.session(sid)['receipts']['back']['state'] == 'completed', 'restored', 10)
            session = self.service.session(sid)
            self.assertEqual(session['reasoning'], 'medium')
            self.assertEqual(session['native_id'], native)
            levels = [level for record in self.service.records(sid) if record.get('native') if (level := json.loads(record['native']).get('data', {}).get('thinkingLevel'))]
            self.assertIn('high', levels)
            self.assertEqual(levels[-1], 'medium')
        finally:
            if self.service and self.service.process:
                self.service.stop()
            api.close()

if __name__=='__main__': unittest.main()
