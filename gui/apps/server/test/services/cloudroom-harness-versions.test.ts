import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppDeps } from "../../src/types.js";
import type { CloudroomClient } from "../../src/services/cloudroom/client.js";

// Issue #96: running `codex --version` from a flagged Codex.app makes macOS trash the whole app. Each fake CLI marks
// that it ran, so the tests see exactly which agent CLIs background work executes.
const CLIS = ["codex", "claude", "opencode", "fx", "openclaw"];
const saved = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
let dir = "", marks = "";
const ran = async () => (await readdir(marks)).sort();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-versions-"));
  marks = join(dir, "ran");
  await mkdir(marks);
  for (const cli of CLIS) await writeFile(join(dir, cli), `#!/bin/sh\ntouch '${join(marks, cli)}'\necho '${cli} 1.2.3'\n`, { mode: 0o755 });
  process.env.PATH = `${dir}:${saved.PATH}`;
  process.env.CODEX_HOME = dir;
  process.env.XDG_DATA_HOME = dir;
  vi.resetModules();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  await rm(dir, { recursive: true, force: true });
});

const deps = { logger: { warn: vi.fn() } } as unknown as AppDeps;
/** Starts the sync and fires its first run, 30 s after launch. */
const firstSync = async (vm: () => Promise<CloudroomClient>) => {
  const { startClaudeVersionSync } = await import("../../src/services/cloudroom/harness-versions.js");
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
  startClaudeVersionSync(deps, vm);
  vi.advanceTimersByTime(30_000);
  vi.useRealTimers();
};

it("the Claude version sync runs no CLI before a VM is connected", async () => {
  const vm = vi.fn(async (): Promise<CloudroomClient> => { throw new Error("Cloud needs a free Cloudroom account. Sign in to use it."); });
  await firstSync(vm);
  await vi.waitFor(() => expect(vm).toHaveBeenCalledTimes(1));
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(await ran()).toEqual([]);
});

it("the Claude version sync runs only Claude's CLI for a VM account", async () => {
  const matchClaudeVersion = vi.fn(async (version: string) => ({ state: "current" as const, target: version }));
  await firstSync(async () => ({ matchClaudeVersion }) as unknown as CloudroomClient);
  await vi.waitFor(() => expect(matchClaudeVersion).toHaveBeenCalledWith("1.2.3"));
  expect(await ran()).toEqual(["claude"]);
});

it("OpenCode's login check runs only OpenCode", async () => {
  const { macOpencodeLogin } = await import("../../src/services/cloudroom/sandboxes.js");
  await macOpencodeLogin();
  expect(await ran()).toEqual(["opencode"]);
});

it("prewarms, preloads, and view wakes run no CLI; a wake for work does, and later background wakes reuse it", async () => {
  const website: { action?: string; thread?: string; harnesses?: unknown; trigger?: string }[] = [];
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text) as (typeof website)[number];
    website.push(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body.action === "mode" ? { sandboxes: true, preload: true }
      : body.action === "wake" ? { thread: body.thread, state: "awake", generation: 1, issue: null, origin: "http://127.0.0.1:9", token: "core" } : {}));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  try {
    const { SandboxDirectory } = await import("../../src/services/cloudroom/sandboxes.js");
    const sandboxes = new SandboxDirectory(async () => ({ website: `http://127.0.0.1:${address.port}`, userId: "user", token: "token" }));
    const project = { id: "project", repository: null, folder: "/code" };
    const harnesses = (action: string) => website.filter(body => body.action === action).map(body => body.harnesses);

    await sandboxes.warm(project, "app_launch");
    await sandboxes.preload([{ thread: "sidebar", project }], async () => {});
    await sandboxes.connection("viewed", project, true, "thread_view");
    expect(await ran()).toEqual([]);
    expect([...harnesses("warm"), ...harnesses("wake")]).toEqual([{}, {}, {}]);

    await sandboxes.connection("sent", project, true);
    expect(await ran()).toEqual([...CLIS].sort());
    const versions = { codex: "1.2.3", claude: "1.2.3", opencode: "1.2.3", fx: "1.2.3", openclaw: "1.2.3" };
    expect(harnesses("wake").at(-1)).toEqual(versions);

    await rm(marks, { recursive: true }); await mkdir(marks);
    await sandboxes.connection("viewed-later", project, true, "thread_view");
    expect(harnesses("wake").at(-1)).toEqual(versions);
    expect(await ran()).toEqual([]);
  } finally { server.close(); }
});

// With #97, findCliExecutable("codex") is null when the only Codex is in Codex.app, even through a PATH symlink. A bare
// `codex` fallback would still reach it through the OS PATH lookup, here the fake on PATH.
it("Codex sign-in and its expiry check never run a bare `codex` when no Codex is found", async () => {
  vi.doMock("@cloudroom/process-utils", async (original) => {
    const utils = await original<typeof import("@cloudroom/process-utils")>();
    return { ...utils, findCliExecutable: (cli: string, env?: NodeJS.ProcessEnv) => cli === "codex" ? null : utils.findCliExecutable(cli, env) };
  });
  try {
    const { macCodexLoginExpired, startMacCodexLogin } = await import("../../src/services/cloudroom/sandboxes.js");
    const run = startMacCodexLogin();
    await vi.waitFor(() => expect(run.done).toBe(true));
    expect(await ran()).toEqual([]);
    expect(run.error).toMatch(/^Codex is not installed/);
    const expired = `x.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.x`;
    await writeFile(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: expired } }));
    expect(await macCodexLoginExpired()).toBe(false);
    expect(await ran()).toEqual([]);
  } finally { vi.doUnmock("@cloudroom/process-utils"); }
});
