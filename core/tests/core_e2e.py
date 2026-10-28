"""Real Rust/Codex tests with a fake website API (tests/fake_api.py). --foundation checks HTTP and diagnostics
without inference.

Copies only the selected account's auth.json to a private disposable Codex home.
Never changes existing databases, checkouts, services, or harness configuration.
"""
import argparse
from contextlib import ExitStack, contextmanager
import hashlib
import http.client
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
# CI points this at the optimized build it ships (ADR 0296).
BINARY = Path(os.environ.get('CLOUDROOM_BIN') or ROOT / 'target/debug/cloudroom')


def run(*args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, timeout=30, **kwargs)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed: {result.stderr.strip()}")
    return result.stdout.strip()


@contextmanager
def fixture_root():
    with tempfile.TemporaryDirectory(prefix="cloudroom-core-e2e-") as tmp:
        root = Path(tmp)
        try:
            yield root
        except BaseException:
            diagnostics = ROOT / "private/core-e2e-failure"
            diagnostics.mkdir(parents=True, exist_ok=True)
            for log in root.glob("*.log"):
                shutil.copy2(log, diagnostics / log.name)
            for record in sorted((root / "state").glob("*.record"))[-40:]:
                shutil.copy2(record, diagnostics / record.name)
            raise


def until(check, label, timeout=120):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.15)
    raise AssertionError("timed out: " + label)


def descendants(pid):
    result, pending = {}, [pid]
    while pending:
        parent = pending.pop()
        for task in Path(f"/proc/{parent}/task").glob("*/children"):
            try:
                children = task.read_text().split()
            except (FileNotFoundError, ProcessLookupError):
                continue
            for child in children:
                if child not in result:
                    try:
                        identity = Path(f"/proc/{child}/stat").read_text().rsplit(")", 1)[1].split()[19]
                    except (FileNotFoundError, ProcessLookupError):
                        continue
                    result[child] = identity
                    pending.append(child)
    return result


def running_processes(owned):
    running = []
    for pid, identity in owned.items():
        try:
            stat = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
            if stat[19] == identity and stat[0] != "Z":
                running.append(pid)
        except (FileNotFoundError, ProcessLookupError):
            pass
    return running


def reap_test_descendants(owned):
    for pid, identity in reversed(list(owned.items())):
        try:
            current = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
            if current == identity:
                os.kill(int(pid), signal.SIGKILL)
        except (FileNotFoundError, ProcessLookupError):
            pass


class Service:
    def __init__(self, env, log):
        self.env, self.log_path = env, log
        self.process = None

    def start(self):
        self.log = self.log_path.open("w+")
        self.process = subprocess.Popen([str(BINARY)], env=self.env,
                                        stdout=self.log, stderr=self.log, start_new_session=True)
        def address():
            assert self.process.poll() is None, "core exited: " + self.log_path.read_text()
            self.log.seek(0)
            return next((line.split()[-1] for line in self.log if line.startswith("Cloudroom listening on ")), None)
        self.address = until(address, "core startup", 10)
        return self

    def stop(self, crash=False):
        if self.process and self.process.poll() is None:
            owned = descendants(self.process.pid)
            self.process.send_signal(signal.SIGKILL if crash else signal.SIGTERM)
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=5)
                if not crash:
                    reap_test_descendants(owned)
                    raise AssertionError("core did not shut down cleanly")
            try:
                if not crash:
                    assert not running_processes(owned), "core left owned processes running after graceful shutdown"
            finally:
                # Cleanup follows the assertion; it must not make the shutdown test pass.
                reap_test_descendants(owned)
        if self.process:
            self.log.close()
        self.process = None

    def request(self, method, path, body=None, expected=200, token=True):
        connection = http.client.HTTPConnection(self.address, timeout=15)
        headers = {"Content-Type": "application/json"}
        if token is not None:
            headers["Authorization"] = "Bearer " + (self.env["CLOUDROOM_TOKEN"] if token is True else token)
        connection.request(method, path, json.dumps(body) if body is not None else None, headers)
        response = connection.getresponse()
        data = response.read()
        connection.close()
        assert response.status == expected, (method, path, response.status, data[:700])
        assert response.getheader("Cache-Control") == "no-store"
        self.diagnostic_id = response.getheader("X-Cloudroom-Diagnostic-Id")
        assert self.diagnostic_id
        connection.close()
        return json.loads(data) if data else None

    def session(self, sid):
        return self.request("GET", "/v1/sessions/" + sid)["session"]

    def records(self, sid):
        records, cursor = [], 0
        while True:
            page = self.request("GET", f"/v1/sessions/{sid}/events?after={cursor}")["events"]
            if not page:
                return records
            assert len(page) <= 256
            assert all(r["sequence"] > cursor for r in page)
            records.extend(page)
            cursor = page[-1]["sequence"]

    def stream(self, sid, after=0):
        connection = http.client.HTTPConnection(self.address, timeout=10)
        connection.request("GET", f"/v1/sessions/{sid}/stream", headers={
            "Authorization": "Bearer " + self.env["CLOUDROOM_TOKEN"], "Last-Event-ID": str(after)})
        response = connection.getresponse()
        assert response.status == 200
        assert response.getheader("Content-Type").startswith("text/event-stream")
        return connection, response


def next_event(response):
    fields = {}
    while True:
        line = response.readline().decode().rstrip("\r\n")
        if not line and "data" in fields:
            record = json.loads(fields["data"])
            assert str(record["sequence"]) == fields["id"]
            return record
        if ":" in line:
            key, value = line.split(":", 1)
            fields[key] = value.lstrip()


def wait_done(service, sid, request, expected="completed"):
    def complete():
        session = service.session(sid)
        receipt = session["receipts"].get(request, {})
        state = receipt.get("state")
        if state in ["failed", "unknown", "unknown_after_restart", "interrupted"] and state != expected:
            raise AssertionError(f"unexpected receipt state {state}: {sid}/{request}")
        return session if state == expected and session["state"] == "idle" else None
    return until(complete, f"{sid}/{request} {expected}")


def check_saved_pagination(service, api):
    records = [{"sequence": n, "session_id": "cr_paged", "kind": "text_delta", "data": {"delta": str(n)}} for n in range(1, 601)]
    receipt = {"request_id": "paged", "command": "start", "input": {}, "state": "accepted"}
    records[0].update(kind="receipt", data=receipt)
    records[99].update(kind="receipt", data={"request_id": "paged"})  # Superseded, incomplete receipt.
    records[299]["data"]["delta"] = "tool output with a NUL: \u0000"
    records[449].update(kind="native_identity", data={"id": "late-native-identity"})
    records[-2].update(kind="receipt", data={**receipt, "state": "completed"})
    records[-1].update(kind="receipt", data={**receipt, "request_id": "other"})
    api.seed("cr_paged", records)
    status = service.session("cr_paged")
    assert status["last_sequence"] == 600 and status["native_id"] == "late-native-identity"
    assert status["state"] == "saved_history_only" and status["receipts"] == {}
    assert service.records("cr_paged") == records
    retry = service.request("POST", "/v1/sessions", {"request_id": "paged"}, 202)
    assert retry["receipt"]["state"] == "completed", "start retry read an old receipt from the first page"
    connection, response = service.stream("cr_paged", 599)
    try:
        assert next_event(response) == records[-1]
    finally:
        response.close(); connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--foundation", action="store_true")
    mode.add_argument("--fixture", action="store_true", help="protocol/API regression tests without inference")
    parser.add_argument("--harness", choices=["codex", "pi"], default="codex")
    args = parser.parse_args()
    if args.fixture and args.harness != "codex":
        raise SystemExit("Use tests/pi_http.py for mixed protocol fixtures")
    if not BINARY.is_file():
        raise SystemExit("BLOCKED: run CARGO_BUILD_JOBS=1 cargo build --locked")
    if not Path("/proc/self/stat").is_file():
        raise SystemExit("BLOCKED: these end-to-end checks require Linux /proc; use tests/core_fixture.py for local HTTP checks")
    if not shutil.which("git"):
        raise SystemExit("BLOCKED: missing test tool git")
    source_home = Path(os.environ.get("CLOUDROOM_TEST_" + args.harness.upper() + "_HOME", str(Path.home() / (".pi/agent" if args.harness == "pi" else ".codex"))))
    if not (args.foundation or args.fixture) and not (source_home / "auth.json").is_file():
        raise SystemExit("BLOCKED: selected harness account has no auth.json")
    from fake_api import FakeApi
    name, token = "cloudroom-core-e2e-" + secrets.token_hex(6), secrets.token_hex(32)
    api, service = FakeApi(token, name), None
    evidence = {"kind": "real " + args.harness + " inference + fake website API", "checks": []}
    evidence_file = ROOT / "private/core-e2e-last.json"
    def passed(label):
        evidence["checks"].append(label)
        print("PASS:", label, flush=True)
    try:
        with fixture_root() as root, ExitStack() as cleanup:
            cleanup.callback(lambda: service.stop() if service else None)
            repo = root / "repo"
            repo.mkdir()
            run("git", "init", "--quiet", str(repo))
            home = root / "home"
            codex_home = home / (".pi/agent" if args.harness == "pi" else ".codex")
            codex_home.mkdir(parents=True)
            model = os.environ.get("CLOUDROOM_TEST_MODEL", "gpt-6-astra")
            (codex_home / "config.toml").write_text('model_reasoning_effort = "low"\n')
            if args.harness == "pi":
                (codex_home / "settings.json").write_text('{"defaultThinkingLevel":"minimal"}')
            if not (args.foundation or args.fixture):
                shutil.copy2(source_home / "auth.json", codex_home / "auth.json")
            env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "CLOUDROOM_UNPROTECTED_TEST_MODE": "1", "CLOUDROOM_LISTEN": "127.0.0.1:0",
                   "CLOUDROOM_TOKEN": token, "CLOUDROOM_STATE_DIR": str(root / "state"),
                   "CLOUDROOM_REPOSITORY": str(repo), **api.env(),
                   "CLOUDROOM_CODEX_BINARY": str(ROOT / "tests/core_fixture.py") if (args.foundation or args.fixture) else "/usr/local/bin/codex", "CLOUDROOM_ACCOUNT_HOME": str(home),
                   "CLOUDROOM_CODEX_HOME": str(codex_home), "CLOUDROOM_MODEL": model,
                   "DATABASE_ADMIN_SECRET": "must-not-reach-harness", "BB_CONTROL_SECRET": "must-not-reach-harness"}
            if args.harness == "pi":
                env.pop("CLOUDROOM_CODEX_BINARY"); env.pop("CLOUDROOM_CODEX_HOME")
                env.update(CLOUDROOM_HARNESS="pi", CLOUDROOM_PI_BINARY=os.environ.get("CLOUDROOM_TEST_PI_BINARY", "/usr/local/bin/pi"),
                           CLOUDROOM_PI_HOME=str(codex_home), CLOUDROOM_PI_PROVIDER=os.environ.get("CLOUDROOM_TEST_PI_PROVIDER", "openai-codex"))
            if args.fixture:
                pi_home = home / ".pi/agent"
                pi_home.mkdir(parents=True)
                env.update(CLOUDROOM_PI_BINARY=str(ROOT / "tests/pi_fixture.py"),
                           CLOUDROOM_PI_HOME=str(pi_home), CLOUDROOM_PI_PROVIDER="default-provider", CLOUDROOM_PI_MODEL="fixture")
            service = Service(env, root / "service.log").start()
            def local_diagnostics():
                records = []
                for path in sorted((root / "state").glob("diagnostics*.jsonl")):
                    for line in path.read_text().splitlines():
                        try:
                            records.append(json.loads(line))
                        except json.JSONDecodeError:
                            pass  # The writer may still be appending the last line; the next read retries it.
                return records
            def diagnostics():
                return list(api.diagnostics)
            for token, expected in [(None, 401), ("wrong", 401), (True, 200)]:
                result = service.request("GET", "/v1/health", expected=expected, token=token)
                if expected == 200:
                    assert result["status"] == "ready"
            collision = subprocess.run([str(BINARY)], env=env, capture_output=True, timeout=5)
            assert collision.returncode != 0
            passed("HTTP auth, client reconnection, and exclusive state ownership")
            if args.fixture:
                from core_fixture import session_checks
                evidence["kind"] = "protocol fixtures + fake website API; no inference"
                session_checks(service, root)
                assert next(h for h in service.request("GET", "/v1/capabilities")["harnesses"] if h["id"] == "pi")["provider_selection"]
                pi_sessions = []
                for provider in [None, "other-provider"]:
                    request = {"request_id": "pi-" + str(provider), "harness": "pi", "model": "family/test-model", "reasoning": "high"}
                    if provider:
                        request["provider"] = provider
                    sid = service.request("POST", "/v1/sessions", request, 202)["session_id"]
                    until(lambda: service.session(sid)["state"] == "idle", "selected Pi provider")
                    assert service.session(sid)["provider"] == (provider or "default-provider")
                    service.request("POST", "/v1/sessions", request, 202)
                    service.request("POST", "/v1/sessions", {**request, "provider": "changed-provider"}, 409)
                    pi_sessions.append((sid, provider or "default-provider", service.session(sid)["native_id"]))
                for harness, provider in [("codex", "other-provider"), ("pi", ""), ("pi", "bad/provider")]:
                    assert service.request("POST", "/v1/sessions", {"request_id": "invalid-provider", "harness": harness, "provider": provider}, 409)["code"] == "invalid_provider"
                service.stop()
                service.env["CLOUDROOM_PI_PROVIDER"] = "changed-default"
                service.start()
                for sid, provider, native in pi_sessions:
                    until(lambda: service.session(sid)["state"] == "idle", "saved Pi provider after restart")
                    assert service.session(sid)["provider"] == provider and service.session(sid)["native_id"] == native
                    frames = [json.loads(r["native"]) for r in service.records(sid) if r.get("native") and r["kind"] != "native_record"]
                    assert any(f.get("command") == "get_state" and f.get("data", {}).get("model", {}).get("provider") == provider for f in frames)
                    service.request("POST", f"/v1/sessions/{sid}/prompts", {"request_id": "followup", "text": "hello"}, 202)
                    until(lambda: service.session(sid)["receipts"]["followup"]["state"] == "completed", "Pi provider follow-up")
                passed("Pi selects providers per session; retries and restart preserve native provider, model and identity")
                passed("acceptance wakes quiet SSE; idle/active close, safe retry, parallel sessions, peer isolation and shutdown")
                check_saved_pagination(service, api)
                passed("bounded saved-history replay with complete late metadata and latest receipts")
                return
            api.down = True
            service.request("GET", "/v1/health?secret=never-log-query")
            service.request("GET", "/never-log-path", expected=404)
            service.request("GET", "/v1/health", expected=401, token="never-log-token")
            denied_id = service.diagnostic_id
            until(lambda: any(r["kind"] == "diagnostics" and r["upload_failures"] > 0 for r in local_diagnostics()),
                  "local diagnostics while the API is down", 30)
            api.down = False
            until(lambda: any(f'{r["run_id"]}-{r["sequence"]}' == denied_id for r in diagnostics()), "diagnostic upload after the API recovers", 30)
            def resource_sample():
                return next((r for r in diagnostics() if r["kind"] == "resources" and r["cpu_used_percent"] is not None), None)
            resource = until(resource_sample, "real Linux resource measurements", 30)
            assert 0 <= resource["cpu_used_percent"] <= 100
            assert 0 <= resource["memory_used_bytes"] <= resource["memory_total_bytes"]
            assert resource["workspace_disk"]["total_bytes"] > 0 and resource["state_disk"]["available_bytes"] > 0
            diagnostic_text = json.dumps(diagnostics()) + json.dumps(local_diagnostics())
            assert not any(secret in diagnostic_text for secret in [env["CLOUDROOM_TOKEN"], str(repo), "never-log-query", "never-log-path", "never-log-token"])
            assert (root / "state/diagnostics.jsonl").stat().st_mode & 0o777 == 0o600
            passed("local/API diagnostics, outage recovery, request correlation, resource measurements and redaction")
            success_ids = set()
            for route in ["/v1/health", "/v1/capabilities", "/v1/dashboard"]:
                for _ in range(20):
                    service.request("GET", route + "?secret=never-log-query")
                    success_ids.add(service.diagnostic_id)
            until(lambda: sum(r.get("requests", 0) for r in diagnostics() if r["kind"] == "api_summary") >= 60,
                  "minute-level API summaries", 75)
            stored = diagnostics()
            assert not any(f'{r["run_id"]}-{r["sequence"]}' in success_ids for r in stored)
            assert success_ids <= {f'{r["run_id"]}-{r["sequence"]}' for r in local_diagnostics()}
            assert any(f'{r["run_id"]}-{r["sequence"]}' == denied_id for r in stored)
            assert "never-log-query" not in json.dumps(stored)
            summaries = [r for r in stored if r["kind"] == "api_summary"]
            assert len(summaries) <= 6 and all(r["total_duration_ms"] >= r["max_duration_ms"] for r in summaries)
            summary_count = sum(r["requests"] for r in summaries)
            service.request("GET", "/v1/health")
            service.stop()
            assert sum(r.get("requests", 0) for r in diagnostics() if r["kind"] == "api_summary") > summary_count
            passed("routine API calls become minute summaries; local correlation, errors, redaction and shutdown flush remain")
            # Diagnostics retention is the website's job now (docs/database/0066).
            service = Service(env, root / "restarted-foundation.log").start()
            if args.foundation:
                evidence["kind"] = "foundation only; no Codex inference"
                return
            sid = service.request("POST", "/v1/sessions", {"request_id": "first"}, 202)["session_id"]
            assert sid == service.request("POST", "/v1/sessions", {"request_id": "first"}, 202)["session_id"]
            until(lambda: service.session(sid)["state"] == "idle", "Codex initialization", 45)
            native_id = service.session(sid)["native_id"]
            assert native_id
            children = descendants(service.process.pid)
            assert children, "Rust service owns no harness child"
            for pid in children:
                keys = {part.split(b"=", 1)[0] for part in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")}
                assert not {b"CLOUDROOM_TOKEN", b"CLOUDROOM_DATABASE_URL", b"DATABASE_ADMIN_SECRET", b"BB_CONTROL_SECRET"} & keys
            passed("native identity before first prompt; Rust-owned child with restricted environment")
            connection, response = service.stream(sid)
            cursor = next_event(response)["sequence"]
            response.close(); connection.close()
            body = {"request_id": "task", "text": "Use a shell command in append mode to add exactly first followed by a newline to counter.txt, creating it if absent. Never overwrite existing content. Read it back and reply READY. Work only in this disposable repository. Do not spawn agents or use the network."}
            first = service.request("POST", f"/v1/sessions/{sid}/prompts", body, 202)
            service.request("POST", f"/v1/sessions/{sid}/prompts", body, 202)
            service.request("POST", f"/v1/sessions/{sid}/prompts", {**body, "text": "different"}, 409)
            assert first["receipt"]["state"] == "accepted"
            wait_done(service, sid, "task")
            assert (repo / "counter.txt").read_text() == "first\n"
            records = service.records(sid)
            assert any(r["kind"] == "item_completed" and (r["data"].get("tool_name") == "bash" if args.harness == "pi" else r["data"]["value"].get("item", {}).get("type") == "commandExecution") for r in records)
            assert any(r["kind"] == "text_delta" for r in records)
            assert any(r["kind"] == "item_completed" and r["data"].get("request_id") == "task" for r in records), "native user message lost its request correlation"
            def complete_native_copy():
                native_path = service.session(sid)["native_path"]
                if not native_path:
                    return False
                originals = [r for r in service.records(sid) if r["kind"] == "native_record"]
                return bool(originals) and b"".join(r["native"].encode() for r in originals) == Path(native_path).read_bytes()
            until(complete_native_copy, "byte-for-byte native rollout capture")
            connection, response = service.stream(sid, cursor)
            replay = [next_event(response) for _ in range(len([r for r in records if r["sequence"] > cursor]))]
            assert replay == [r for r in records if r["sequence"] > cursor]
            assert len({r["sequence"] for r in replay}) == len(replay)
            response.close(); connection.close()
            passed("real repository task, tool output, deduplication, detach and ordered SSE replay")
            follow = {"request_id": "follow", "text": "Use a shell command to append exactly second and a newline to counter.txt once. Then read the file and report its contents. Do not edit anything else or spawn agents."}
            service.request("POST", f"/v1/sessions/{sid}/prompts", follow, 202)
            wait_done(service, sid, "follow")
            assert (repo / "counter.txt").read_text() == "first\nsecond\n"
            assert service.session(sid)["native_id"] == native_id
            passed("follow-up in the same native and Cloudroom session")
            (repo / "stop-job.py").write_text(
                "import os, sys, time\nfrom pathlib import Path\n"
                "name = sys.argv[1]\np = Path(name + '.ticks')\ntmp = p.with_suffix('.tmp')\n"
                "Path(name + '.pid').write_text(str(os.getpid()))\n"
                "for n in range(1, 226):\n"
                "    tmp.write_text(str(n)); tmp.replace(p); print(n, flush=True); time.sleep(.2)\n"
                "Path('should-not-exist' if name == 'interrupt' else 'unrelated.txt').write_text('bad' if name == 'interrupt' else 'OK')\n")
            interrupt_body = {"request_id": "long", "text": "Run exactly python3 stop-job.py interrupt in the foreground. Wait for it to finish. Do not edit the script, spawn agents or do any other work."}
            service.request("POST", f"/v1/sessions/{sid}/prompts", interrupt_body, 202)
            until(lambda: (repo / "interrupt.ticks").exists(), "interruptible tool")
            before_second = descendants(service.process.pid)
            sid2 = service.request("POST", "/v1/sessions", {"request_id": "second"}, 202)["session_id"]
            until(lambda: service.session(sid2)["state"] == "idle", "second Codex session", 45)
            second_children = descendants(service.process.pid)
            # Pi changes its process title, overwriting Linux's visible command line.
            second_harness = str(next(r["data"]["pid"] for r in reversed(service.records(sid2)) if r["kind"] == "harness"))
            assert second_harness not in before_second and second_harness in second_children
            assert Path(f"/proc/{second_harness}/stat").read_text().rsplit(")", 1)[1].split()[1] == str(service.process.pid)
            second_identity = second_children[second_harness]
            third = service.request("POST", "/v1/sessions", {"request_id": "third-session"}, 202)["session_id"]
            until(lambda: service.session(third)["state"] == "idle", "third live session", 45)
            service.request("POST", f"/v1/sessions/{third}/close", {"request_id": "close-third"}, 202)
            until(lambda: service.session(third)["state"] == "closed", "third session closed")
            service.request("POST", f"/v1/sessions/{sid2}/prompts", {"request_id": "independent", "text": "Run exactly python3 stop-job.py other in the foreground. Wait for it to finish. Do not edit the script, spawn agents or do any other work."}, 202)
            until(lambda: (repo / "other.ticks").exists(), "second running tool")
            target_pid = (repo / "interrupt.pid").read_text()
            owned = descendants(service.process.pid)
            assert target_pid in owned, "target tool is not owned by this Rust service"
            stop = {"request_id": "stop", "target_request_id": "long"}
            service.request("POST", f"/v1/sessions/{sid}/interrupt", stop, 202)
            stopped = wait_done(service, sid, "long", "interrupted")
            assert stopped["receipts"]["stop"]["state"] == "completed"
            target_tick = (repo / "interrupt.ticks").read_text()
            other_tick = int((repo / "other.ticks").read_text())
            time.sleep(3)
            assert (repo / "interrupt.ticks").read_text() == target_tick, "interrupted tool kept writing"
            assert descendants(service.process.pid).get(target_pid) != owned[target_pid], "interrupted tool process is still alive"
            assert int((repo / "other.ticks").read_text()) > other_tick, "Stop affected the other session's tool"
            assert service.session(sid)["native_id"] == native_id
            wait_done(service, sid2, "independent")
            service.request("POST", f"/v1/sessions/{sid}/interrupt", stop, 202)
            service.request("POST", f"/v1/sessions/{sid}/interrupt", {**stop, "request_id": "stale-stop"}, 409)
            assert (repo / "unrelated.txt").read_text().strip() == "OK"
            assert not (repo / "should-not-exist").exists()
            evidence["stop"] = {"target_pid": target_pid, "target_final_tick": int(target_tick),
                                "no_writes_after_completed_stop_seconds": 3, "other_tool_continued": True}
            passed("targeted interruption stops actual tool writes/process; safe retry, stale-stop rejection, unaffected running second session")
            assert descendants(service.process.pid).get(second_harness) == second_identity, "test harness identity changed"
            os.kill(int(second_harness), signal.SIGKILL)
            until(lambda: any(r["kind"] == "agent_exit" and r["session_id"] == sid2 and not r["expected"] for r in diagnostics()), "recorded harness crash")
            until(lambda: any(r["kind"] == "harness" and r["data"].get("pid") not in (None, int(second_harness)) for r in service.records(sid2)), "replacement for crashed harness")
            until(lambda: service.session(sid2)["state"] == "idle", "automatic native resume", 45)
            service.request("POST", f"/v1/sessions/{sid2}/prompts", {"request_id": "after-crash", "text": "Reply RECOVERED. Do not run tools or do other work."}, 202)
            wait_done(service, sid2, "after-crash")
            identities = {r["data"]["id"] for r in service.records(sid2) if r["kind"] == "native_identity"}
            assert identities == {service.session(sid2)["native_id"]}, "agent crash changed native conversation"
            assert any(r["kind"] == "agent_start" and r["session_id"] == sid and r["success"] and r["duration_ms"] > 0 for r in diagnostics())
            assert body["text"] not in json.dumps(diagnostics())
            passed("real harness crash automatically resumes the same native conversation; follow-up succeeds; diagnostics contain no conversation copies")
            service.request("POST", f"/v1/sessions/{sid2}/close", {"request_id": "close-recovered"}, 202)
            until(lambda: service.session(sid2)["state"] == "closed", "recovered session closed")
            close_id = service.request("POST", "/v1/sessions", {"request_id": "close-idle"}, 202)["session_id"]
            until(lambda: service.session(close_id)["state"] == "idle", "idle close candidate", 45)
            extra = service.request("POST", "/v1/sessions", {"request_id": "alongside-idle"}, 202)["session_id"]
            until(lambda: service.session(extra)["state"] == "idle", "idle peers do not block starts", 45)
            service.request("POST", f"/v1/sessions/{extra}/close", {"request_id": "close-extra"}, 202)
            until(lambda: service.session(extra)["state"] == "closed", "extra session closed")
            close = {"request_id": "close"}
            service.request("POST", f"/v1/sessions/{close_id}/close", close, 202)
            until(lambda: service.session(close_id)["state"] == "closed" and service.session(close_id)["receipts"]["close"]["state"] == "completed", "idle close completion")
            service.request("POST", f"/v1/sessions/{close_id}/close", close, 202)
            close_id = service.request("POST", "/v1/sessions", {"request_id": "close-active"}, 202)["session_id"]
            until(lambda: service.session(close_id)["state"] == "idle", "replacement session", 45)
            service.request("POST", f"/v1/sessions/{close_id}/prompts", {"request_id": "job", "text": "Run exactly python3 stop-job.py closing in the foreground and wait. Do not edit files, spawn agents, or do other work."}, 202)
            until(lambda: (repo / "closing.pid").exists(), "tool to close")
            close_pid = (repo / "closing.pid").read_text()
            closing_processes = descendants(service.process.pid)
            assert close_pid in closing_processes
            service.request("POST", f"/v1/sessions/{close_id}/close", close, 202)
            until(lambda: service.session(close_id)["state"] == "closed" and service.session(close_id)["receipts"]["close"]["state"] == "completed", "active close completion")
            assert not running_processes({close_pid: closing_processes[close_pid]})
            close_tick = (repo / "closing.ticks").read_text()
            time.sleep(.5)
            assert (repo / "closing.ticks").read_text() == close_tick
            assert service.session(sid)["native_id"] == native_id and service.session(sid)["state"] == "idle"
            passed("real idle/active session close, stable retries, parallel sessions and tool exit before cleanup")
            api.down = True
            outage = {"request_id": "outage", "text": "Run this shell command: python3 -c \"from pathlib import Path; import time; p=Path('counter.txt'); p.open('a').write('outage\\n'); Path('outage-started').write_text('ready'); time.sleep(45); Path('after-crash').write_text('bad')\". Wait for it to finish. Do not spawn agents or do other work."}
            service.request("POST", f"/v1/sessions/{sid}/prompts", outage, 202)
            until(lambda: (repo / "outage-started").exists(), "agent progress during an API outage")
            assert service.request("GET", "/v1/health")["saving"]["pending_records"] > 0
            until(lambda: any(r["kind"] == "history_upload" and not r["success"] and r["pending_records"] > 0 for r in local_diagnostics()),
                  "local failed-upload diagnostics while agents continue", 15)
            service.request("POST", f"/v1/sessions/{sid}/interrupt", {"request_id": "delayed-stop", "target_request_id": "long"}, 409)
            # Queue a follow-up while the outage turn is still busy; it must survive the crash.
            queued_follow = {"request_id": "queued-follow", "text": "Use a shell command in append mode to add exactly resumed followed by a newline to counter.txt. Never overwrite existing content. Then read the file and reply DONE. Do not spawn agents or do other work."}
            service.request("POST", f"/v1/sessions/{sid}/prompts", queued_follow, 202)
            assert service.session(sid)["queue"] == ["queued-follow"], service.session(sid)["queue"]
            time.sleep(0.5)
            before = (repo / "counter.txt").read_text()
            service.stop(crash=True)
            service = Service(env, root / "restarted.log").start()
            # Abrupt loss is not permission to resend the uncertain in-flight command.
            assert not (repo / "after-crash").exists()
            retry = service.request("POST", f"/v1/sessions/{sid}/prompts", outage, 202)
            assert retry["receipt"]["state"] == "unknown_after_restart"
            # The running session resumes the same native conversation and identity.
            until(lambda: service.session(sid)["state"] == "idle", "resume after crash", 90)
            assert service.session(sid)["native_id"] == native_id
            # The never-dispatched queued prompt runs after resume, exactly once.
            wait_done(service, sid, "queued-follow")
            assert (repo / "counter.txt").read_text() == before + "resumed\n"
            api.down = False
            until(lambda: service.request("GET", "/v1/health")["saving"]["pending_records"] == 0, "pending upload recovery", 60)
            until(lambda: any(r["kind"] == "history_upload" and r["success"] and r["pending_records"] == 0 for r in diagnostics()), "diagnostic uploads recover")
            passed("work continues during an API outage; local diagnostics remain available; crash resumes the same native session; queued work survives and runs once; uncertain command is not repeated")
            service.stop()
            (root / "state/saved").write_text("0")
            service = Service(env, root / "reupload.log").start()
            # Normal restarts now resume this session. Finish it before freezing the
            # expected history, so later service shutdown cannot append more records.
            until(lambda: service.session(sid)["state"] == "idle", "resume after normal restart", 45)
            assert service.session(sid)["native_id"] == native_id
            service.request("POST", f"/v1/sessions/{sid}/close", {"request_id": "close-before-export"}, 202)
            until(lambda: service.session(sid)["state"] == "closed" and service.session(sid)["receipts"]["close-before-export"]["state"] == "completed", "finished export source")
            until(lambda: service.request("GET", "/v1/health")["saving"]["pending_records"] == 0, "idempotent reupload", 60)
            saved = service.records(sid)
            assert len(api.records("cr_first")) == len(saved)
            passed("replaying already-committed uploads creates no duplicate saved records")
            shutdown_id = service.request("POST", "/v1/sessions", {"request_id": "shutdown"}, 202)["session_id"]
            until(lambda: service.session(shutdown_id)["state"] == "idle", "shutdown session", 45)
            service.request("POST", f"/v1/sessions/{shutdown_id}/prompts", {"request_id": "job", "text": "Run exactly python3 stop-job.py shutdown in the foreground and wait. Do not edit files, spawn agents, or do other work."}, 202)
            until(lambda: (repo / "shutdown.ticks").exists(), "active tool during shutdown")
            attached, attached_response = service.stream(sid)
            next_event(attached_response)
            service.stop()
            shutdown_tick = (repo / "shutdown.ticks").read_text()
            time.sleep(.5)
            assert (repo / "shutdown.ticks").read_text() == shutdown_tick
            attached_response.close(); attached.close()
            passed("graceful shutdown stops actual owned tools before cleanup and closes an attached SSE client")
            fresh_repo, fresh_home = root / "fresh-repo", root / "fresh-home"
            fresh_repo.mkdir(); (fresh_home / ".codex").mkdir(parents=True)
            run("git", "init", "--quiet", str(fresh_repo))
            restored_env = {**env, "CLOUDROOM_STATE_DIR": str(root / "fresh-state"), "CLOUDROOM_REPOSITORY": str(fresh_repo),
                            "CLOUDROOM_ACCOUNT_HOME": str(fresh_home), ("CLOUDROOM_PI_HOME" if args.harness == "pi" else "CLOUDROOM_CODEX_HOME"): str(fresh_home / ".codex")}
            service = Service(restored_env, root / "restored.log").start()
            assert service.session(sid)["state"] == "saved_history_only"
            assert service.records(sid) == saved
            assert service.request("POST", "/v1/sessions", {"request_id": "first"}, 202)["session_id"] == sid
            assert not (fresh_repo / "counter.txt").exists()
            passed("saved-history-only recovery with fresh state, fresh workspace and no native credentials/history")
            check_saved_pagination(service, api)
            passed("bounded saved-history replay with complete late metadata and latest receipts")
            evidence.update(model=model, native_id=native_id, session_id=sid, record_count=len(saved),
                            history_sha256=hashlib.sha256(json.dumps(saved, sort_keys=True).encode()).hexdigest(),
                            limitation="The fake API runs in this test. Real R2 and website durability are not verified here.")
    finally:
        if service:
            service.stop()
        api.close()
        evidence_file.parent.mkdir(exist_ok=True)
        evidence_file.write_text(json.dumps(evidence, indent=2) + "\n")


if __name__ == "__main__":
    main()
