import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cloudroomThreads, createThread, listEvents } from "@cloudroom/db";
import { CloudroomConnectionError, UPLOAD_PART, CloudroomClient } from "../../src/services/cloudroom/client.js";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { GATHER_MS, cloudForkPoint, localCheckpoint, landForkCode, sourceCode, threadCode, uploadInParts } from "../../src/services/cloudroom/fork.js";
import { projectRecord } from "../../src/services/cloudroom/events.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

const linux = it.skipIf(process.platform !== "linux");
let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "cloudroom-fork-code-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function sandbox(home: string, workspace: string, before?: (command: string) => Promise<void>, limit = ""): CloudroomClient {
  mkdirSync(home, { recursive: true });
  return {
    sessionWorkspace: async () => ({ path: workspace, branch: null, head: null }),
    runOnVm: async (input: { command: string; stdin?: string }, _signal?: AbortSignal, bytes?: Uint8Array) => {
      await before?.(input.command);
      const result = spawnSync("bash", ["-c", limit + input.command], { cwd: home, env: { ...process.env, HOME: home }, input: bytes ?? Buffer.from(input.stdin ?? "", "hex") });
      return { code: result.status ?? 1, stdout: result.stdout.toString("hex"), stderr: result.stderr.toString("hex"), truncated: false };
    },
  } as unknown as CloudroomClient;
}

function folder(name: string, files: Record<string, string>): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    writeFileSync(join(path, file), text);
  }
  return path;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args]).toString();

function clone(files: Record<string, string>, name = "child"): string {
  const path = folder(name, files);
  git(path, "init", "-q");
  git(path, "add", "-A");
  git(path, "commit", "-qm", "init");
  return path;
}

async function copy(parent: string, child: string, id: string): Promise<string | null> {
  const code = await sourceCode(sandbox(join(root, "parent-home"), parent), parent, id);
  return landForkCode(sandbox(join(root, "child-home"), child), { sessionId: "s", transfer: id, code: Promise.resolve(code) });
}

linux("leaves a child's GitHub clone whole when the parent's folder is empty", async () => {
  const child = clone({ "README.md": "b", "src/a.ts": "a" });
  expect(await copy(folder("parent", {}), child, "t1")).toBeNull();
  expect(git(child, "status", "--porcelain")).toBe("");
});

linux("lays a parent's plain files over a child's GitHub clone and deletes nothing", async () => {
  const child = clone({ "README.md": "b", "src/a.ts": "a" });
  expect(await copy(folder("parent", { "src/a.ts": "edited", "new.ts": "n" }), child, "t2")).toBeNull();
  expect(git(child, "status", "--porcelain")).toBe(" M src/a.ts\n?? new.ts\n");
  expect(readFileSync(join(child, "src/a.ts"), "utf8")).toBe("edited");
});

linux("mirrors the parent's files into a child with no Git repository, and an empty parent removes nothing", async () => {
  const child = folder("child", { ".env": "KEY=1", "stale.ts": "s", "node_modules/x.js": "x" });
  expect(await copy(folder("empty", {}), child, "t3")).toBeNull();
  expect(existsSync(join(child, ".env")) && existsSync(join(child, "stale.ts"))).toBe(true);

  expect(await copy(folder("parent", { ".env": "KEY=2", "a.ts": "a" }), child, "t4")).toBeNull();
  expect(existsSync(join(child, "stale.ts"))).toBe(false);
  expect(readFileSync(join(child, ".env"), "utf8")).toBe("KEY=2");
  expect(existsSync(join(child, "a.ts")) && existsSync(join(child, "node_modules/x.js"))).toBe(true);
});

linux("keeps a repo the agent cloned into a child with no Git before the parent's files landed (#588)", async () => {
  const child = folder("child", { "stale.ts": "s" });
  const repo = clone({ "README.md": "r", "src/a.ts": "a" }, "child/repo");
  writeFileSync(join(repo, "check.sh"), "new");
  expect(await copy(folder("parent", { "a.ts": "a" }), child, "t6")).toBeNull();
  expect(git(repo, "status", "--porcelain")).toBe("?? check.sh\n");
  expect(existsSync(join(child, "stale.ts"))).toBe(false);
});

linux("changes nothing when the parent's files overlap a repo the agent cloned (#588)", async () => {
  const cases = [["t7", "vendor/repo", "vendor"], ["t8", "vendor/repo", "vendor/repo/README.md"], ["t9", "vendor/.cache/repo", "vendor"], ["t10", "vendor/build/repo", "vendor"]] as const;
  for (const [id, at, path] of cases) {
    const child = folder(`child-${id}`, { "stale.ts": "s" });
    const repo = clone({ "README.md": "r" }, `child-${id}/${at}`);
    expect(await copy(folder(`parent-${id}`, { [path]: "p", "a.ts": "a" }), child, id)).toContain(`${at} is a Git repository`);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(existsSync(join(child, "stale.ts")) && !existsSync(join(child, "a.ts"))).toBe(true);
  }
});

linux("never writes through a clone's symlink into .git", async () => {
  const child = folder("child", { "README.md": "b" });
  symlinkSync(".git", join(child, "alias"));
  git(child, "init", "-q");
  git(child, "add", "-A");
  git(child, "commit", "-qm", "init");
  const config = readFileSync(join(child, ".git/config"), "utf8");
  expect(await copy(folder("parent", { "alias/config": "x" }), child, "t5")).toBeNull();
  expect(readFileSync(join(child, ".git/config"), "utf8")).toBe(config);
  expect(lstatSync(join(child, "alias")).isDirectory()).toBe(true);
  expect(readFileSync(join(child, "alias/config"), "utf8")).toBe("x");
});

linux("a failed pack leaves no archive on the parent's disk, and clears day-old ones a cut-off transfer left", async () => {
  const parent = folder("parent", {});
  writeFileSync(join(parent, "big.bin"), randomBytes(2 * 1024 * 1024));
  const home = join(root, "parent-home");
  const cache = folder("parent-home/.cache/cloudroom", { "child_old.tgz.list": "", "copy-1.tgz": "", "fork_now.bundle": "" });
  const old = Date.now() / 1000 - 2 * 86_400;
  for (const name of ["child_old.tgz.list", "copy-1.tgz"]) utimesSync(join(cache, name), old, old);
  await expect(sourceCode(sandbox(home, parent, undefined, "ulimit -f 512; "), parent, "full")).rejects.toThrow();
  expect(readdirSync(cache).sort()).toEqual(["copy-1.tgz", "fork_now.bundle"]);
});

linux("children started together share one pack, later ones share the next, which holds what the parent wrote after, and full packs wait their turn", async () => {
  const harness = await createTestAppHarness();
  try {
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
    const thread = createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: "idle" });
    harness.deps.db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: "http://parent", startRequestId: "parent", sessionId: "cr_parent", model: "m", reasoning: "medium" }).run();
    const parent = clone({ "README.md": "r" });
    const home = join(root, "parent-home");
    let packs = 0, mostArchives = 0, started = () => {}, release = () => {};
    const first = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(cloudroom(harness.deps), "threadClient").mockResolvedValue(sandbox(home, parent, async (command) => {
      mostArchives = Math.max(mostArchives, existsSync(join(home, ".cache/cloudroom")) ? readdirSync(join(home, ".cache/cloudroom")).length : 0);
      if (!command.includes("git bundle create")) return;
      if (++packs === 1) { started(); await gate; }
    }));
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const gather = async () => {
      await vi.waitFor(() => { if (vi.getTimerCount() === 0) throw new Error("no pack waiting yet"); });
      await vi.advanceTimersByTimeAsync(GATHER_MS);
    };
    const one = threadCode(harness.deps, thread.id, "child_1");
    await vi.advanceTimersByTimeAsync(GATHER_MS - 1_000);
    expect(threadCode(harness.deps, thread.id, "child_1b")).toBe(one);
    await vi.advanceTimersByTimeAsync(1_000);
    await first;
    writeFileSync(join(parent, "brief-2.md"), "do 2");
    const two = threadCode(harness.deps, thread.id, "child_2");
    const three = threadCode(harness.deps, thread.id, "child_3");
    release();
    await one;
    await gather();
    expect(await two).toBe(await three);
    expect(packs).toBe(2);
    expect(mostArchives).toBeLessThanOrEqual(1);
    const child = folder("child", {});
    expect(await landForkCode(sandbox(join(root, "child-home"), child), { sessionId: "s", transfer: "child_3", code: three })).toBeNull();
    expect(readFileSync(join(child, "brief-2.md"), "utf8")).toBe("do 2");
    const full = async (code: Promise<unknown>) => ((await code) as { full: () => Promise<Buffer> }).full();
    await Promise.all([full(one), full(two), full(three)]);
    expect(packs).toBe(4);
    expect(mostArchives).toBeLessThanOrEqual(1);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await harness.cleanup();
  }
});

linux("a dropped upload part is resent, and its late original rewrites the same bytes (#1314)", async () => {
  const home = join(root, "home"), data = randomBytes(2 * UPLOAD_PART + 1000);
  const real = sandbox(home, root);
  let late = async () => {}, sends = 0;
  const client = { runOnVm: async (input: { command: string }, signal?: AbortSignal, bytes?: Uint8Array) => {
    const result = await real.runOnVm(input, signal, bytes as Uint8Array<ArrayBuffer>);
    // The second part lands, then its answer is lost: the retry sends it again, and the original runs once more at the end.
    if (++sends === 2) { late = async () => { await real.runOnVm(input, signal, bytes as Uint8Array<ArrayBuffer>); }; throw new CloudroomConnectionError("Cloudroom is unreachable: socket hang up"); }
    return result;
  } } as unknown as CloudroomClient;
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  try {
    const done = uploadInParts(client, "up", data, new AbortController().signal);
    await vi.waitFor(() => { if (vi.getTimerCount() === 0) throw new Error("no retry waiting yet"); });
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
  } finally {
    vi.useRealTimers();
  }
  await late();
  expect(sends).toBe(4);
  expect(readFileSync(join(home, "up")).equals(data)).toBe(true);
});

linux("forks the retained reply after a Cloud edit, or offers only a verified checkpoint", async () => {
  const harness = await createTestAppHarness();
  try {
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
    // An edit replaces Claude's session. Fork the prior final reply using the replacement prompt.
    const cloud = createThread(harness.db, harness.hub, { executionTarget: "cloud", projectId: project.id, providerId: "claude-code", status: "idle" });
    const sessionId = "cr_edit";
    harness.db.insert(cloudroomThreads).values({ threadId: cloud.id, coreUrl: "https://core.invalid", sessionId, nativeId: "original", startRequestId: "start", model: "test-model", reasoning: "medium" }).run();
    let recordSeq = 0;
    const emit = (kind: string, data: Record<string, string | { text: string }>) => projectRecord(harness.db, cloud.id, { kind, data, session_id: sessionId, sequence: ++recordSeq });
    const turn = (id: string) => {
      emit("receipt", { request_id: id, command: "prompt", state: "accepted", input: { text: id } });
      emit("state", { state: "starting_turn", request_id: id });
      emit("checkpoint", { request_id: id, id: `prompt-${id}` });
    };
    turn("first");
    emit("item_completed", { harness: "claude-code", request_id: "first", item_type: "text", item_id: "one", text: "Kept reply", provider_checkpoint_id: "old-reply" });
    emit("receipt", { request_id: "first", command: "prompt", state: "completed" });
    const selected = listEvents(harness.db, { threadId: cloud.id }).find(row => row.type === "item/completed")!.sequence;
    const completion = listEvents(harness.db, { threadId: cloud.id }).find(row => row.type === "turn/completed")!.sequence;
    turn("second");
    emit("rewind", { before: "prompt-second", id: "edited", request_id: "edit" });

    const transcript = Buffer.from([
      { type: "assistant", uuid: "copied-reply" },
      { type: "user", uuid: "prompt-replacement", parentUuid: "copied-reply" },
      { type: "assistant", uuid: "later-reply" },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const home = folder("edited-home", { ".claude/projects/project/edited.jsonl": transcript.toString() });
    vi.spyOn(cloudroom(harness.deps), "threadClient").mockResolvedValue(sandbox(home, home));
    const checkEdited = () => harness.app.request(`/api/v1/threads/${cloud.id}/fork-point/${selected}`);
    // With no matching checkpoint, a later unrelated prompt must never become the cutoff.
    emit("checkpoint", { request_id: "unrelated", id: "later" });
    expect(await (await checkEdited()).json()).toEqual({ exact: false, sequence: null });
    turn("replacement");
    expect(await (await checkEdited()).json()).toEqual({ exact: true, sequence: completion });
    const point = await cloudForkPoint(harness.deps, cloud, selected);
    expect(point).toEqual({ source_thread_id: cloud.id, end_sequence: completion, before: "prompt-replacement" });
    expect(localCheckpoint("claude-code", transcript, point)).toBe("copied-reply");

    writeFileSync(join(harness.deps.config.dataDir, "cloudroom.json"), JSON.stringify({ url: "https://core.invalid", token: "x".repeat(40) }), { mode: 0o600 });
    vi.spyOn(CloudroomClient.prototype, "health").mockResolvedValue({});
    vi.spyOn(CloudroomClient.prototype, "capabilities").mockResolvedValue({
      version: 1, repository: "/test", stop: true, resume: true, launch_settings: true, side_chat: true,
      harnesses: [{ id: "claude-code", model: "test-model" }],
    });
    cloudroom(harness.deps).stop(); // The fixture serves the fork request without a background Core stream.
    const start = vi.spyOn(CloudroomClient.prototype, "start").mockImplementation(async (id) => ({
      session_id: "child", receipt: { request_id: id, command: "start", state: "accepted", input: {} }, saving: null, pending: false,
    }));
    const response = await harness.app.request("/api/v1/threads/fork", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceThreadId: cloud.id, sourceSeqEnd: selected, visibility: "visible" }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    expect(start.mock.lastCall?.[2]?.fork).toMatchObject({ session: sessionId, before: "prompt-replacement" });
    const child = await response.json() as { id: string };
    const timeline = await harness.app.request(`/api/v1/threads/${child.id}/timeline`);
    const { rows } = await timeline.json() as { rows: { kind: string; text?: string }[] };
    expect(rows.filter(row => row.kind === "conversation").map(row => row.text)).toEqual(["first", "Kept reply"]);

    // If the edited transcript retained the assistant UUID, prefer that exact message.
    writeFileSync(join(home, ".claude/projects/project/edited.jsonl"), transcript.toString().replaceAll("copied-reply", "old-reply"));
    expect(await (await checkEdited()).json()).toEqual({ exact: true, sequence: selected });

    // A progress reply followed by more work cannot use its turn end after another edit.
    for (const id of ["progress", "done"]) {
      emit("item_completed", { harness: "claude-code", request_id: "replacement", item_type: "text", item_id: id, text: id, provider_checkpoint_id: id });
    }
    emit("receipt", { request_id: "replacement", command: "prompt", state: "completed" });
    const progress = listEvents(harness.db, { threadId: cloud.id }).find(row => row.itemId === "replacement:progress")!.sequence;
    turn("third");
    emit("rewind", { before: "prompt-third", id: "edited-again", request_id: "edit-again" });
    const activeFile = join(home, ".claude/projects/project/edited-again.jsonl");
    writeFileSync(activeFile, transcript);
    const preview = () => harness.app.request(`/api/v1/threads/${cloud.id}/fork-point/${progress}`);
    expect(await (await preview()).json()).toEqual({ exact: false, sequence: completion });
    writeFileSync(activeFile, transcript.toString().replace("prompt-replacement", "different-prompt"));
    expect(await (await preview()).json()).toEqual({ exact: false, sequence: null });
  } finally {
    cloudroom(harness.deps).stop();
    vi.restoreAllMocks();
    await harness.cleanup();
  }
});
