import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cloudroomThreads, createThread } from "@cloudroom/db";
import type { CloudroomClient } from "../../src/services/cloudroom/client.js";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { GATHER_MS, landForkCode, sourceCode, threadCode } from "../../src/services/cloudroom/fork.js";
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

function clone(files: Record<string, string>): string {
  const path = folder("child", files);
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

linux("a failed pack leaves no archive on the parent's disk", async () => {
  const parent = folder("parent", {});
  writeFileSync(join(parent, "big.bin"), randomBytes(2 * 1024 * 1024));
  const home = join(root, "parent-home");
  await expect(sourceCode(sandbox(home, parent, undefined, "ulimit -f 512; "), parent, "full")).rejects.toThrow();
  expect(readdirSync(join(home, ".cache/cloudroom"))).toEqual([]);
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
