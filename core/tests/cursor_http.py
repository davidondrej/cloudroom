#!/usr/bin/env python3
"""Disposable Cursor account HTTP checks with a deterministic CLI; no real credentials."""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest

from core_e2e import Service, run, until

KEY = 'cursor-test-key-PRIVATE-CANARY'


def cursor():
    home = Path(os.environ['HOME'])
    if '--list-models' in sys.argv:
        good = os.environ.get('CURSOR_API_KEY') == KEY
        print('default' if good else 'invalid key')
        return 0 if good else 1
    if 'status' in sys.argv:
        print(json.dumps({'isAuthenticated': (home / 'connected').exists(), 'userInfo': {'email': 'fixture@example.invalid'}}))
        return 0
    if 'login' in sys.argv:
        assert os.environ.get('NO_OPEN_BROWSER') == '1'
        with (home / 'attempts').open('a') as log: log.write('login\n')
        (home / 'login-pid').write_text(str(os.getpid()))
        print('Open https://cursor.com/loginDeepControl?challenge=fixture&uuid=fixture&mode=login&redirectTarget=cli', flush=True)
        while not (home / 'finish').exists(): time.sleep(.03)
        (home / 'connected').touch()
        return 0
    raise AssertionError('Unexpected Cursor invocation')


class CursorAccounts(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='cloudroom-cursor-auth-')
        self.root = Path(self.directory.name)
        self.home = self.root / 'home'
        self.cursor_home = self.home / '.cursor'
        self.cursor_home.mkdir(parents=True)
        (self.home / '.codex').mkdir()
        (self.home / '.local/bin').mkdir(parents=True)
        (self.home / '.local/bin/cursor-agent').symlink_to(Path(__file__).resolve())
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        run('git', 'init', '--quiet', str(self.repo))
        self.state = self.root / 'state'
        self.state.mkdir()
        env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'CLOUDROOM_UNPROTECTED_TEST_MODE': '1',
               'CLOUDROOM_LISTEN': '127.0.0.1:0', 'CLOUDROOM_TOKEN': 'fixture-' + 'x' * 40,
               'CLOUDROOM_STATE_DIR': str(self.state), 'CLOUDROOM_REPOSITORY': str(self.repo),
               'CLOUDROOM_LOCAL_HISTORY': '1', 'CLOUDROOM_STORE': 'fixture',
               'CLOUDROOM_ACCOUNT_HOME': str(self.home),
               'CLOUDROOM_CODEX_BINARY': str(Path(__file__).resolve()),
               'CLOUDROOM_CODEX_HOME': str(self.home / '.codex'), 'CLOUDROOM_MODEL': 'fixture'}
        self.env = env
        self.service = Service(env, self.root / 'core.log')
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(self.service.stop)
        self.service.start()

    def tearDown(self):
        self.service.stop()
        self.directory.cleanup()

    def account(self, action=None, request='attempt', key=None):
        body = {'request_id': request, **({'api_key': key} if key is not None else {})}
        return self.service.request('POST' if action else 'GET', '/v1/accounts/cursor' + ('/' + action if action else ''), body if action else None, expected=202 if action else 200)

    def test_login_retry_cancel_and_restart(self):
        from workspaces import WorkspaceTests
        self.service.stop()
        WorkspaceTests.api(self)
        self.service.start()
        self.service.request('GET', '/v1/accounts/cursor', expected=401, token=None)
        self.assertEqual(self.account()['state'], 'missing')
        error = self.service.request('POST', '/v1/sessions', {'request_id': 'start', 'harness': 'cursor'}, expected=409)
        self.assertEqual(error['code'], 'cursor_auth_required')
        self.assertEqual(self.account('login')['state'], 'waiting')
        status = until(lambda: (v if (v := self.account()).get('verification_url') else None), 'Cursor login link', 10)
        self.assertTrue(status['verification_url'].startswith('https://cursor.com/loginDeepControl?'))
        self.assertEqual(self.account('login')['login_id'], 'attempt')
        self.assertEqual((self.home / 'attempts').read_text().splitlines(), ['login'])
        self.assertEqual(self.account('cancel', 'wrong-id')['state'], 'waiting')
        self.assertEqual(self.account('cancel')['state'], 'missing')
        self.account('login', 'success')
        (self.home / 'finish').touch()
        until(lambda: self.account()['state'] == 'connected', 'native browser login', 10)
        self.service.stop()
        self.service.start()
        self.assertEqual(self.account()['state'], 'connected')

    def test_key_is_private_verified_and_never_recorded(self):
        self.assertEqual(self.account('key', key='invalid')['state'], 'error')
        destination = self.cursor_home / 'cloudroom-api-key'
        self.assertFalse(destination.exists())
        self.assertEqual(self.account('key', key=KEY)['state'], 'connected')
        self.assertEqual(destination.read_text(), KEY)
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.account('key', key='invalid')['state'], 'error')
        self.assertEqual(destination.read_text(), KEY)
        self.service.stop()
        self.service.start()
        self.assertEqual(self.account()['state'], 'connected')
        self.service.stop()
        for path in self.state.rglob('*'):
            if path.is_file(): self.assertNotIn(KEY.encode(), path.read_bytes(), str(path))
        self.assertNotIn(KEY, (self.root / 'core.log').read_text())

    def test_key_symlink_is_not_followed(self):
        outside = self.root / 'unrelated'
        outside.write_text('preserve')
        (self.cursor_home / 'cloudroom-api-key').symlink_to(outside)
        self.assertEqual(self.account('key', key=KEY)['state'], 'error')
        self.assertEqual(outside.read_text(), 'preserve')

    def test_shutdown_cancels_owned_login(self):
        self.account('login')
        until(lambda: (self.home / 'login-pid').exists(), 'owned login process', 10)
        self.service.stop()
        self.service.start()
        self.assertEqual(self.account()['state'], 'missing')


if __name__ == '__main__':
    if any(arg in sys.argv for arg in ('status', 'login', '--list-models')):
        sys.exit(cursor())
    unittest.main()
