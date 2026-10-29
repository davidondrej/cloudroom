#!/usr/bin/env python3
"""Fake a plan limit in a Cloud sandbox, so testing #229 costs no real usage.

  sudo python3 fake_limit.py install claude|codex [SECONDS]   # SECONDS until the fake reset, default 120
  sudo python3 fake_limit.py uninstall claude|codex

Then a turn whose prompt contains FAKE_LIMIT ends like the provider's real plan limit; `FAKE_LIMIT x3` fails the
next 3 turns, so resumes hit the limit again. Other turns run normally.
Installed, this file wraps the real binary, which moves to `<binary>.real`. New sessions pick it up.
To test a branch's Core, install it over /usr/local/lib/cloudroom/cloudroom (leave `commit` alone, or the next wake
reinstalls the pinned one) and restart Core as its own account: `sudo runuser -u cloudroom -- pkill -x cloudroom`.
"""
import json, os, re, shutil, subprocess, sys, threading, time

RESET_SECS = 120


def binary(harness):
    if harness == 'claude':
        paths = ['/home/cloudroom-agent/.local/bin/claude', '/usr/local/bin/claude']
    else:
        env = open('/etc/cloudroom/core.env').read()
        paths = re.findall(r'^CLOUDROOM_CODEX_BINARY=(.+)$', env, re.M) + ['/usr/local/bin/codex']
    return next(p for p in paths if os.path.lexists(p + '.real') or os.path.isfile(p))


def manage(action, harness, seconds):
    path = binary(harness)
    if action == 'install' and not os.path.lexists(path + '.real'):
        os.rename(path, path + '.real')
    if action == 'install':
        # Core gives harnesses their own environment, so the wrapper names its Python outright.
        text = open(__file__).read().replace('RESET_SECS = 120', f'RESET_SECS = {int(seconds)}', 1).replace('/usr/bin/env python3', sys.executable, 1)
        open(path, 'w').write(text)
        os.chmod(path, 0o755)
    elif os.path.lexists(path + '.real'):
        os.replace(path + '.real', path)
    print(f'{action}ed at {path}')


def limited(message, reset):
    """The provider's own way to say "plan limit, resets at `reset`", replacing `message`, a finished turn."""
    if message.get('type') == 'result':
        info = {'status': 'rejected', 'resetsAt': reset, 'rateLimitType': 'five_hour'}
        message.update(is_error=True, result="You've hit your session limit · resets soon (UTC)")
        return [{'type': 'rate_limit_event', 'session_id': message.get('session_id'), 'rate_limit_info': info}, message]
    if message.get('method') == 'turn/completed':
        window = {'usedPercent': 100, 'windowDurationMins': 300, 'resetsAt': reset}
        message['params']['turn'].update(status='failed', error={'message': "You've hit your usage limit.", 'codexErrorInfo': 'usageLimitExceeded'})
        return [{'method': 'account/rateLimits/updated', 'params': {'rateLimits': {'limitId': 'codex', 'primary': window}}}, message]
    return None


def wrap():
    real = subprocess.Popen([sys.argv[0] + '.real', *sys.argv[1:]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
    armed = [0]

    def feed():
        for line in sys.stdin:
            if 'FAKE_LIMIT' in line:
                armed[0] = int((re.search(r'FAKE_LIMIT x(\d+)', line) or [0, 1])[1])
            real.stdin.write(line)
            real.stdin.flush()
        real.stdin.close()

    threading.Thread(target=feed, daemon=True).start()
    for line in real.stdout:
        try:
            message = json.loads(line)
        except ValueError:
            message = None
        fake = armed[0] > 0 and isinstance(message, dict) and limited(message, int(time.time()) + RESET_SECS)
        if fake:
            armed[0] -= 1
            line = ''.join(json.dumps(m) + '\n' for m in fake)
        sys.stdout.write(line)
        sys.stdout.flush()
    sys.exit(real.wait())


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] in ('install', 'uninstall') and sys.argv[2] in ('claude', 'codex'):
        manage(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else RESET_SECS)
    else:
        wrap()
