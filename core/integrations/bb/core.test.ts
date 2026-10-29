import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { CloudroomClient, CloudroomError } from "./client.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const driver = `
import json,sys,os
sys.path.insert(0, 'tests')
from core_fixture import ReplayTests,run
fixture=ReplayTests()
fixture.setUp()
try:
    from workspaces import WorkspaceTests
    WorkspaceTests.api(fixture)
    fixture.start()
    print(json.dumps({'url':'http://'+fixture.service.address,'token':fixture.env['CLOUDROOM_TOKEN']}),flush=True)
    for line in sys.stdin:
        command=line.strip()
        if command=='release':
            (fixture.repo/'release').touch()
            print('{}',flush=True)
        elif command=='restart':
            fixture.service.stop()
            fixture.start()
            print(json.dumps({'url':'http://'+fixture.service.address,'token':fixture.env['CLOUDROOM_TOKEN']}),flush=True)
        elif command=='restore':
            fixture.service.stop()
            for path in [fixture.state,fixture.repo,fixture.root/'home']:
                path.rename(path.with_name(path.name+'-unavailable'))
            fixture.state.mkdir(); fixture.repo.mkdir()
            run('git','init','--quiet',str(fixture.repo))
            (fixture.root/'home'/'.codex').mkdir(parents=True)
            fixture.start()
            print(json.dumps({'url':'http://'+fixture.service.address,'token':fixture.env['CLOUDROOM_TOKEN']}),flush=True)
        elif command=='native-files':
            print(json.dumps(list(map(str,(fixture.root/'home'/'.codex').rglob('*.jsonl')))),flush=True)
        elif command=='stop': break
finally:
    fixture.tearDown()
`;

async function until(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await sleep(30);
  }
  throw new Error("Core fixture did not reach the expected state");
}

test(
  "Rust HTTP: queue, detach, retry, native restart, close and external-history recovery",
  { timeout: 30_000 },
  async (t) => {
    const process = spawn("python3", ["-u", "-c", driver], {
      cwd: root,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const lines = createInterface({ input: process.stdout })[
      Symbol.asyncIterator
    ]();
    const next = async () => {
      const line = await lines.next();
      assert(!line.done, "core fixture exited before reporting its address");
      return JSON.parse(line.value);
    };
    t.after(async () => {
      if (process.exitCode !== null) return;
      const exited = once(process, "exit");
      process.stdin.end();
      await exited;
    });
    let client = new CloudroomClient(await next());
    const capabilities = await client.capabilities();
    assert.match(JSON.stringify(capabilities.harnesses), /"reasoning_levels":\["low","medium","high","xhigh","max"\]/);
    for (const options of [{ model: "fixture", reasoning: "ultra" }, { model: "basic", reasoning: "max" }, { model: "missing", reasoning: "high" }]) {
      await assert.rejects(client.start("invalid", "codex", options), (error: unknown) => {
        assert(error instanceof CloudroomError);
        assert.equal(error.retryable, false);
        assert.equal(error.code, options.model === "missing" ? "invalid_model" : "invalid_reasoning_effort");
        return true;
      });
    }
    const max = await client.start("bb-max", "codex", { model: "fixture", reasoning: "max" });
    await until(async () => (await client.session(max.session_id)).state === "idle");
    await client.prompt(max.session_id, "max-prompt", "verify max");
    await until(async () => (await client.session(max.session_id)).receipts["max-prompt"]?.state === "completed");
    const nativeRecords = (await client.events(max.session_id)).filter(record => record.kind === "native_record").map(record => JSON.parse(record.native!));
    assert(nativeRecords.some(record => record.fixture === "launch" && record.reasoning === "max"));
    assert(nativeRecords.some(record => record.fixture === "turn" && record.reasoning === "max"));
    assert.equal((await client.start("bb-max", "codex", { model: "fixture", reasoning: "max" })).session_id, max.session_id);
    await client.close(max.session_id, "max-close");
    await until(async () => (await client.session(max.session_id)).state === "closed");
    const started = await client.start("bb-create");
    const id = started.session_id;
    await until(async () => (await client.session(id)).state === "idle");
    const native = (await client.session(id)).native_id;
    assert(native);
    await client.prompt(id, "first", "delay");
    await until(
      async () => (await client.session(id)).current_request === "first",
    );
    const queued = await client.prompt(id, "second", "after-first");
    assert.equal(queued.receipt.state, "accepted");
    assert((await client.session(id)).queue.includes("second"));
    let cursor = 0;
    for await (const record of client.stream(id, {
      signal: AbortSignal.timeout(5000),
    })) {
      cursor = record.sequence;
      break;
    }
    process.stdin.write("release\n");
    await next();
    await until(
      async () =>
        (await client.session(id)).receipts.second?.state === "completed",
    );
    assert.equal(
      (await client.prompt(id, "second", "after-first")).receipt.state,
      "completed",
    );
    const replay = await client.events(id, cursor);
    assert(replay.length > 0);
    assert(replay.every((record) => record.sequence > cursor));
    process.stdin.write("restart\n");
    client = new CloudroomClient(await next());
    await until(async () => (await client.session(id)).state === "idle");
    assert.equal((await client.session(id)).native_id, native);
    assert.equal((await client.session(id)).receipts.second.state, "completed");
    await client.close(id, "bb-close");
    await until(async () => (await client.session(id)).state === "closed");
    assert.equal(
      (await client.session(id)).receipts["bb-close"].state,
      "completed",
    );
    const lastSequence = (await client.session(id)).last_sequence;
    await until(async () => {
      const health = await client.health();
      const saving = health.saving;
      return (
        typeof saving === "object" &&
        saving !== null &&
        "externally_saved_through" in saving &&
        typeof saving.externally_saved_through === "number" &&
        saving.externally_saved_through >= lastSequence
      );
    });
    const saved = await client.events(id);
    process.stdin.write("restore\n");
    client = new CloudroomClient(await next());
    assert.equal((await client.session(id)).state, "saved_history_only");
    assert.deepEqual(await client.events(id), saved);
    assert.equal((await client.start("bb-create")).session_id, id);
    process.stdin.write("native-files\n");
    assert.deepEqual(await next(), []);
  },
);
