import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { DRIVER, assetFor } from "./driver.js";
import { inspectBrowserControl } from "./browser-control.js";
import {
  createHostEntry,
  driverEnv,
  install,
  pruneOldVersions,
  reconcileBringToFront,
  unsupportedGnomeHint,
  workingXauthority,
} from "./host.js";
import computerUsePlugin, {
  blockedBrowserAction,
  decideGate,
  isBrowserApp,
  isCloudroomApp,
} from "./server.js";

const disk = vi.hoisted(() => ({ full: false }));
const proc = vi.hoisted(() => ({
  execFile: null as
    | ((
        file: string,
        args: readonly string[],
        options?: { env?: NodeJS.ProcessEnv },
      ) => Promise<{ stdout: string; stderr: string }>)
    | null,
  spawn: null as ((file: string, args: readonly string[]) => unknown) | null,
}));
vi.mock("node:fs", async (actual) => {
  const fs = await actual<typeof import("node:fs")>();
  const enospc = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", syscall: "write" });
  const full = () => new Writable({ write: (_chunk, _encoding, done) => done(enospc) });
  return { ...fs, createWriteStream: ((...args) => (disk.full ? full() : fs.createWriteStream(...args))) as typeof fs.createWriteStream };
});
vi.mock("node:child_process", async (actual) => {
  const cp = await actual<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = Object.assign(
    ((...args: Parameters<typeof cp.execFile>) =>
      cp.execFile(...args)) as typeof cp.execFile,
    {
      [promisify.custom]: (
        file: string,
        args: readonly string[] = [],
        options?: { env?: NodeJS.ProcessEnv },
      ) =>
        proc.execFile
          ? proc.execFile(file, args, options)
          : promisify(cp.execFile)(file, args, options as never),
    },
  );
  return {
    ...cp,
    execFile,
    spawn: ((file: string, args: readonly string[], options?: unknown) =>
      proc.spawn
        ? proc.spawn(file, args)
        : cp.spawn(file, args, options as never)) as typeof cp.spawn,
  };
});

describe("decideGate", () => {
  it("asks about the app an action targets, and never lets input skip the question", () => {
    expect(decideGate({ tool: "list_apps", input: {} })).toEqual({ kind: "free" });
    expect(decideGate({ tool: "list_windows", input: { pid: 42 } })).toEqual({ kind: "free" });
    expect(decideGate({ tool: "click", input: { pid: 42, element_token: "s1:3" } })).toEqual({ kind: "pid", pid: 42 });
    expect(decideGate({ tool: "type_text", input: { text: "hi" } }).kind).toBe("error");
    expect(decideGate({ tool: "launch_app", input: { bundle_id: "com.apple.TextEdit" } })).toEqual({
      kind: "name",
      name: "com.apple.TextEdit",
    });
    expect(decideGate({ tool: "get_desktop_state", input: {} })).toEqual({ kind: "screen" });
    expect(decideGate({ tool: "move_cursor", input: { x: 1, y: 2 } })).toEqual({ kind: "screen" });
    expect(decideGate({ tool: "browser_click", input: { delivery_mode: "foreground" } })).toEqual({ kind: "screen" });
    expect(decideGate({ tool: "click", input: { pid: 42, delivery_mode: "foreground" } })).toEqual({ kind: "pid", pid: 42 });
    for (const tool of ["clipboard_read", "clipboard_write"])
      expect(decideGate({ tool, input: { pid: 42 } }).kind).toBe("clipboard");
    expect(decideGate({ tool: "set_config", input: {} }).kind).toBe("error");
  });
});

it("refuses an app macOS doesn't know without an approval card", async () => {
  const permissions = { accessibility: true, screenRecording: true };
  const fake = createFakePluginHost({
    sdk: { threads: { get: async () => ({ host: { id: "mac" } }) } },
    experimental_callHostRpc: ({ method }) =>
      method === "prepare"
        ? {
            platform: "darwin",
            supported: true,
            reason: null,
            version: "0",
            installed: true,
            running: false,
            permissions,
            installMs: null,
          }
        : null,
  });
  await computerUsePlugin(fake.bb);
  const result = await fake.harness.runCli(
    ["call", "launch_app", '{"bundle_id":"com.example.nope"}'],
    { threadId: "thr_1" },
  );
  expect(JSON.parse(result.stdout ?? "").error).toBe("app_not_installed");
  expect(fake.harness.pendingInteractions).toEqual([]);
  expect(
    fake.harness.experimental_hostRpcCalls.map((call) => call.method),
  ).toEqual(["prepare", "appForName"]);
});

it("lets a granted thread launch an app without re-asking", async () => {
  const status = {
    platform: "darwin",
    supported: true,
    reason: null,
    version: "0",
    installed: true,
    running: false,
    permissions: { accessibility: true, screenRecording: true },
  };
  const replies: Record<string, unknown> = {
    prepare: { ...status, installMs: null },
    status,
    appForName: { key: "com.apple.TextEdit", name: "TextEdit" },
    call: { exitCode: 0, stdout: "", stderr: "", driverExits: 0 },
  };
  const fake = createFakePluginHost({
    sdk: { threads: { get: async () => ({ host: { id: "mac" } }) } },
    experimental_callHostRpc: ({ method }) => replies[method],
  });
  await fake.bb.storage.kv.set("thread-granted/thr_1", true);
  await computerUsePlugin(fake.bb);
  const result = await fake.harness.runCli(
    ["call", "launch_app", '{"name":"TextEdit"}'],
    { threadId: "thr_1" },
  );
  expect(result.exitCode).toBe(0);
  // The host builds the screenshot folder from its own temp dir (#1411).
  expect(fake.harness.experimental_hostRpcCalls.find((call) => call.method === "call")?.input).toEqual({
    tool: "launch_app",
    args: { name: "TextEdit" },
    session: expect.any(String),
    shotsKey: "thr_1",
  });
});

// #1960: an approved clipboard read needs no Accessibility and no app lock.
it("lets approved threads read the clipboard without Accessibility", async () => {
  const status = {
    platform: "darwin",
    supported: true,
    reason: null,
    version: "0",
    installed: true,
    running: true,
    permissions: { accessibility: false, screenRecording: true },
  };
  const replies: Record<string, unknown> = {
    prepare: { ...status, installMs: null },
    status,
    call: { exitCode: 0, stdout: "", stderr: "", driverExits: 0 },
  };
  const fake = createFakePluginHost({
    sdk: { threads: { get: async () => ({ host: { id: "mac" } }) } },
    experimental_callHostRpc: ({ method }) => replies[method],
  });
  await fake.bb.storage.kv.set("thread-granted/thr_1", true);
  await fake.bb.storage.kv.set("thread-granted/thr_2", true);
  await computerUsePlugin(fake.bb);
  const read = ["call", "clipboard_read", "{}"];
  for (const threadId of ["thr_1", "thr_2"])
    expect((await fake.harness.runCli(read, { threadId })).exitCode).toBe(0);
});

// Cua Driver exact_result for #1506 / #1625: focused under a helper, or verified while off-Space.
const unverified = {
  status: "partial",
  code: "bring_to_front_exact_window_unverified",
  pid: 42,
  window_id: 7,
  activated: false,
  process_activated: true,
  exact_window_effect: {
    verified: false,
    focused: true,
    front_in_process_on_display: false,
    target_visible_ordinary: true,
  },
  observed: {
    frontmost_pid: 42,
    front_process_matches_target: true,
    focused_window_id: 7,
    process_front_window_on_display: 9,
  },
};
const verified = {
  ...unverified,
  status: "activated",
  code: "bring_to_front_exact_window_verified",
  activated: true,
  exact_window_effect: {
    ...unverified.exact_window_effect,
    verified: true,
    front_in_process_on_display: true,
    frontmost_ordinary: true,
    unobstructed: true,
  },
  observed: { ...unverified.observed, process_front_window_on_display: 7 },
};
const win = (
  window_id: number,
  z_index: number | null,
  title: string,
  width: number,
  height: number,
) => ({
  window_id,
  pid: 42,
  title,
  z_index,
  is_on_screen: z_index !== null,
  layer: 0,
  bounds: { x: 0, y: 0, width, height },
});
const document = win(7, 5, "Docs", 1400, 900);
const helpers = [document, win(8, 6, "", 1400, 41), win(9, 7, "", 1400, 41)];

it.each([
  [
    "only 41 px untitled helpers on top",
    {},
    { pid: 42, window_id: 7 },
    helpers,
    0,
    "bring_to_front_exact_window_focused",
  ],
  [
    "41 px helpers with off-Space sibling (null z_index) and non-layer-0 window",
    {},
    { pid: 42, window_id: 7 },
    [
      ...helpers,
      { ...win(10, null, "Other Space", 1400, 900), on_current_space: false },
      { ...win(11, 8, "Overlay", 300, 300), layer: 25 },
    ],
    0,
    "bring_to_front_exact_window_focused",
  ],
  [
    "full titled sibling on top",
    {},
    { pid: 42, window_id: 7 },
    [document, win(9, 7, "Other tab", 1400, 900)],
    1,
    null,
  ],
  [
    "larger untitled companion layer-0 surface on top",
    {},
    { pid: 42, window_id: 7 },
    [document, win(9, 7, "", 400, 300)],
    1,
    null,
  ],
  [
    "target off screen",
    {},
    { pid: 42, window_id: 7 },
    [{ ...document, is_on_screen: false }, ...helpers.slice(1)],
    1,
    null,
  ],
  [
    "target on another Space even while on screen",
    {},
    { pid: 42, window_id: 7 },
    [
      {
        ...document,
        on_current_space: false,
        current_space_id: 1,
        space_ids: [4],
      },
      ...helpers.slice(1),
    ],
    1,
    "bring_to_front_window_off_space",
  ],
  [
    "not focused",
    {
      exact_window_effect: {
        ...unverified.exact_window_effect,
        focused: false,
      },
    },
    { pid: 42, window_id: 7 },
    helpers,
    1,
    null,
  ],
  [
    "another window focused",
    { observed: { ...unverified.observed, focused_window_id: 9 } },
    { pid: 42, window_id: 7 },
    helpers,
    1,
    null,
  ],
  [
    "front process unknown",
    {
      observed: { ...unverified.observed, front_process_matches_target: null },
    },
    { pid: 42, window_id: 7 },
    helpers,
    1,
    null,
  ],
  ["another window requested", {}, { pid: 42, window_id: 8 }, helpers, 1, null],
])(
  "bring_to_front unverified: %s",
  async (_name, patch, input, windows, exitCode, expectedCode) => {
    const stdout = JSON.stringify({ ...unverified, ...patch });
    const list = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ windows }),
      stderr: "",
    });
    const result = await reconcileBringToFront(
      "bring_to_front",
      input,
      { exitCode: 1, stdout, stderr: "" },
      list,
    );
    expect(result.exitCode).toBe(exitCode);
    if (expectedCode === null) expect(result.stdout).toBe(stdout);
    else if (exitCode === 0)
      expect(JSON.parse(result.stdout ?? "")).toMatchObject({
        status: "activated",
        activated: true,
        code: expectedCode,
        exact_window_effect: { verified: false },
      });
    else
      expect(JSON.parse(result.stdout ?? "")).toMatchObject({
        status: "partial",
        activated: false,
        code: expectedCode,
        exact_window_effect: { verified: false, on_current_space: false },
        observed: {
          on_current_space: false,
          current_space_id: 1,
          space_ids: [4],
        },
      });
  },
);

it.each([
  [
    "target on current Space stays verified",
    [
      {
        ...document,
        on_current_space: true,
        current_space_id: 1,
        space_ids: [1],
      },
    ],
    0,
    "bring_to_front_exact_window_verified",
  ],
  [
    "target on another Space (off screen) fails as off-Space",
    [
      {
        ...win(7, null, "Docs", 1400, 900),
        on_current_space: false,
        current_space_id: 1,
        space_ids: [4],
      },
    ],
    1,
    "bring_to_front_window_off_space",
  ],
  [
    "target on another Space while on screen fails as off-Space",
    [
      {
        ...document,
        on_current_space: false,
        current_space_id: 1,
        space_ids: [4],
      },
    ],
    1,
    "bring_to_front_window_off_space",
  ],
  [
    "target off screen with unknown Space fails as unverified",
    [{ ...win(7, null, "Docs", 1400, 900), on_current_space: null }],
    1,
    "bring_to_front_exact_window_unverified",
  ],
])("bring_to_front verified: %s", async (_name, windows, exitCode, code) => {
  const stdout = JSON.stringify(verified);
  const list = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ windows, current_space_id: 1 }),
    stderr: "",
  });
  const result = await reconcileBringToFront(
    "bring_to_front",
    { pid: 42, window_id: 7 },
    { exitCode: 0, stdout, stderr: "" },
    list,
  );
  expect(result.exitCode).toBe(exitCode);
  if (exitCode === 0) expect(result.stdout).toBe(stdout);
  else {
    const offScreen = windows[0]?.is_on_screen === false;
    expect(JSON.parse(result.stdout ?? "")).toMatchObject({
      status: "partial",
      activated: false,
      code,
      exact_window_effect: {
        verified: false,
        ...(offScreen
          ? {
              target_visible_ordinary: false,
              front_in_process_on_display: false,
              frontmost_ordinary: false,
              unobstructed: false,
            }
          : {}),
      },
    });
  }
});

// Cua Driver 0.35.2's real refusal when Cloudroom starts it without --grant existing-profile (#1555).
it("tells the agent which browser route works when the driver wants an existing-profile grant", async () => {
  const refusal = {
    refusal: {
      code: "browser_consent_required",
      detail: { next_action: "browser_prepare", reason: "consumer_profile_endpoint_requires_grant" },
      message: "this standalone browser profile requires explicit existing-profile approval",
    },
    status: "refused",
  };
  const status = { platform: "darwin", supported: true, reason: null, version: "0", installed: true, running: true, permissions: { accessibility: true, screenRecording: true } };
  const replies: Record<string, unknown> = {
    prepare: { ...status, installMs: null },
    call: { exitCode: 0, stdout: JSON.stringify(refusal), stderr: "", driverExits: 0 },
  };
  const fake = createFakePluginHost({
    sdk: { threads: { get: async () => ({ host: { id: "mac" } }) } },
    experimental_callHostRpc: ({ method }) => replies[method],
  });
  await computerUsePlugin(fake.bb);
  const result = await fake.harness.runCli(["call", "get_browser_state", "{}"], { threadId: "thr_1" });
  expect(JSON.parse(result.stdout ?? "")).toEqual({ ...refusal, hint: expect.stringContaining("browser-harness") });
});

// #2450: a set XAUTHORITY stops the driver finding the cookie itself, so pass only one that works.
it.runIf(process.platform !== "win32")("passes XAUTHORITY to the driver only when the X server accepts its cookie", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xauth-"));
  const good = Buffer.from("fake-cookie-0001");
  // X5 answers by cookie; X6 hangs up without replying.
  const server = createServer((socket) => socket.once("data", (setup) => socket.end(Buffer.from([setup.includes(good) ? 1 : 0]))));
  const hangup = createServer((socket) => socket.once("data", () => socket.end()));
  await new Promise<void>((resolve) => server.listen(join(dir, "X5"), resolve));
  await new Promise<void>((resolve) => hangup.listen(join(dir, "X6"), resolve));
  const field = (value: Buffer) => Buffer.concat([Buffer.from([0, value.length]), value]);
  const entry = (cookie: Buffer) => Buffer.concat([Buffer.from([0xff, 0xff]), ...[Buffer.alloc(0), Buffer.from(""), Buffer.from("MIT-MAGIC-COOKIE-1"), cookie].map(field)]);
  const xauth = async (name: string, data: Buffer) => {
    await writeFile(join(dir, name), data);
    return join(dir, name);
  };
  vi.stubEnv("XAUTHORITY", "/fake/xauth");
  vi.stubEnv("CUA_DRIVER_RS_ENABLE_WAYLAND", "1");
  try {
    expect(driverEnv("/private-home")).toMatchObject({ HOME: "/private-home", CUA_DRIVER_RS_ENABLE_WAYLAND: "1" });
    expect(driverEnv("/private-home").XAUTHORITY).toBeUndefined();
    const valid = await xauth("valid", entry(good));
    expect(await workingXauthority(":5", valid, dir)).toBe(valid);
    expect(await workingXauthority(":5", await xauth("stale", entry(Buffer.from("fake-cookie-9999"))), dir)).toBeUndefined();
    expect(await workingXauthority(":5", join(dir, "missing"), dir)).toBeUndefined();
    // The driver rejects a whole file with a cut-off entry, even after a good one.
    expect(await workingXauthority(":5", await xauth("truncated", Buffer.concat([entry(good), entry(good).subarray(0, 9)])), dir)).toBeUndefined();
    execFileSync("mkfifo", [join(dir, "fifo")]);
    const started = Date.now();
    expect(await workingXauthority(":5", join(dir, "fifo"), dir)).toBeUndefined();
    expect(await workingXauthority(":6", valid, dir)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  } finally {
    vi.unstubAllEnvs();
    server.close();
    hangup.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// #2685: Cua's WinRects helper refuses GNOME 50+, so only offer its install on Shells its metadata lists.
it("offers WinRects only on GNOME Shells the bundled helper supports", () => {
  const metadata = JSON.stringify({ uuid: "winrects@cua", "shell-version": ["45", "46", "47", "48", "49"] });
  expect(unsupportedGnomeHint("GNOME Shell 49.2\n", metadata, true)).toBeNull();
  expect(unsupportedGnomeHint("GNOME Shell 50.1\n", metadata, true)).toMatch(/only GNOME Shell 45, 46, 47, 48, 49, and this is GNOME Shell 50,.*Don't install/);
  expect(unsupportedGnomeHint("", metadata, true)).toMatch(/unknown version/);
  expect(unsupportedGnomeHint("GNOME Shell 50.1\n", null, false)).toMatch(/unknown until the driver is installed/);
  expect(unsupportedGnomeHint("GNOME Shell 49.2\n", metadata, false)).toMatch(/unknown until the driver is installed/);
  expect(unsupportedGnomeHint("GNOME Shell 49.2\n", null, true)).toMatch(/metadata is missing.*Don't install or enable it\.$/);
});

// #1242: GitHub's download sometimes answers 5xx; retry it, never skip the checksum.
it.runIf(assetFor(process.platform, process.arch))("install retries GitHub's transient download failures", async () => {
  const ok = () => new Response("not the driver");
  const rows: [string, (() => Response)[], RegExp, number, boolean?][] = [
    ["504 then 200", [() => new Response("", { status: 504 }), ok], /checksum/, 2],
    ["network error then 200", [() => { throw new TypeError("fetch failed"); }, ok], /checksum/, 2],
    ["persistent 504", Array(4).fill(() => new Response("", { status: 504 })), /HTTP 504\) after 4 tries.*GitHub/, 4],
    ["404", [() => new Response("", { status: 404 })], /HTTP 404\)$/, 1],
    ["disk full", [ok, ok], /^ENOSPC/, 1, true],
  ];
  const root = await mkdtemp(join(tmpdir(), "cua-install-"));
  try {
    for (const [name, replies, error, calls, full = false] of rows) {
      disk.full = full;
      const fetch = vi.fn(async () => replies[fetch.mock.calls.length - 1]!());
      vi.stubGlobal("fetch", fetch);
      await expect(install(join(root, "driver"), new AbortController().signal, [0, 0, 0]), name).rejects.toThrow(error);
      expect(fetch, name).toHaveBeenCalledTimes(calls);
    }
  } finally {
    disk.full = false;
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});

describe("active computer-use indicator state", () => {
  const readyStatus = {
    platform: "darwin",
    supported: true,
    reason: null,
    version: "0",
    installed: true,
    running: true,
    permissions: { accessibility: true, screenRecording: true },
  };

  it("publishes active-changed signals and returns active threads via getActive", async () => {
    const replies: Record<string, unknown> = {
      prepare: { ...readyStatus, installMs: null },
      status: readyStatus,
      appForName: { key: "com.brave.Browser", name: "Brave" },
      call: { exitCode: 0, stdout: "{}", stderr: "", driverExits: 0 },
      release: null,
    };
    const fake = createFakePluginHost({
      sdk: { threads: { get: async () => ({ host: { id: "mac" } }) } },
      experimental_callHostRpc: ({ method }) => replies[method],
    });
    await fake.bb.storage.kv.set("thread-granted/thr_1", true);
    await computerUsePlugin(fake.bb);

    expect(await fake.harness.callRpc("getActive", null)).toEqual({
      active: [],
    });

    // Free tool starts an active session with appName: null.
    expect(
      (await fake.harness.runCli(["call", "list_apps", "{}"], { threadId: "thr_1" }))
        .exitCode,
    ).toBe(0);
    expect(await fake.harness.callRpc("getActive", null)).toEqual({
      active: [{ threadId: "thr_1", appName: null }],
    });

    // Targeting an app fills in appName.
    expect(
      (
        await fake.harness.runCli(
          ["call", "launch_app", '{"name":"Brave"}'],
          { threadId: "thr_1" },
        )
      ).exitCode,
    ).toBe(0);
    expect(await fake.harness.callRpc("getActive", null)).toEqual({
      active: [{ threadId: "thr_1", appName: "Brave" }],
    });

    // Subsequent free tool call keeps the known appName.
    expect(
      (await fake.harness.runCli(["call", "list_windows", "{}"], { threadId: "thr_1" }))
        .exitCode,
    ).toBe(0);
    expect(await fake.harness.callRpc("getActive", null)).toEqual({
      active: [{ threadId: "thr_1", appName: "Brave" }],
    });

    // end_session clears the active indicator immediately.
    expect(
      (await fake.harness.runCli(["call", "end_session", "{}"], { threadId: "thr_1" }))
        .exitCode,
    ).toBe(0);
    expect(await fake.harness.callRpc("getActive", null)).toEqual({
      active: [],
    });

    const activeSignals = fake.harness.realtimeSignals
      .filter((s) => s.channel === "active-changed")
      .map((s) => s.payload);
    expect(activeSignals).toEqual([
      { active: [{ threadId: "thr_1", appName: null }] },
      { active: [{ threadId: "thr_1", appName: "Brave" }] },
      { active: [] },
    ]);
  });

  it("clears active state when a thread becomes idle or its host restarts", async () => {
    const replies: Record<string, unknown> = {
      prepare: { ...readyStatus, installMs: null },
      status: readyStatus,
      call: { exitCode: 0, stdout: "{}", stderr: "", driverExits: 0 },
      release: null,
      restart: readyStatus,
    };
    const hosts: Record<string, string> = { thr_1: "mac-1", thr_2: "mac-2" };
    const fake = createFakePluginHost({
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({
            host: { id: hosts[threadId] ?? "mac-1" },
          }),
        },
        hosts: {
          list: async () => [{ id: "mac-2", status: "connected" }],
        },
      },
      experimental_callHostRpc: ({ method }) => replies[method],
    });
    await computerUsePlugin(fake.bb);

    await fake.harness.runCli(["call", "list_apps", "{}"], { threadId: "thr_1" });
    await fake.harness.runCli(["call", "list_apps", "{}"], { threadId: "thr_2" });
    expect(await fake.harness.callRpc("getActive", null)).toEqual({
      active: [
        { threadId: "thr_1", appName: null },
        { threadId: "thr_2", appName: null },
      ],
    });

    await fake.harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_1", projectId: "proj_1" }),
      lastAssistantText: "Done",
    });
    expect(await fake.harness.callRpc("getActive", null)).toEqual({
      active: [{ threadId: "thr_2", appName: null }],
    });

    await fake.harness.callRpc("restart", null);
    expect(await fake.harness.callRpc("getActive", null)).toEqual({
      active: [],
    });
  });
});

describe("thread-level approval", () => {
  const readyStatus = {
    platform: "darwin",
    supported: true,
    reason: null,
    version: "0.59.5",
    installed: true,
    running: true,
    permissions: { accessibility: true, screenRecording: true },
  };

  function setup(appsByPid: Record<number, { key: string; name: string }> = { 42: { key: "com.brave.Browser", name: "Brave" } }) {
    return createFakePluginHost({
      sdk: { threads: { get: async () => ({ host: { id: "mac" } }) } },
      experimental_callHostRpc: ({ method, input }) => {
        if (method === "prepare") return { ...readyStatus, installMs: null };
        if (method === "status") return readyStatus;
        if (method === "appForPid") return appsByPid[(input as { pid: number }).pid] ?? null;
        if (method === "call")
          return { exitCode: 0, stdout: JSON.stringify(verified), stderr: "", driverExits: 0 };
        return null;
      },
    });
  }

  it("asks once per thread, blocks on deny, and covers other apps and foreground calls once allowed", async () => {
    const fake = setup({
      42: { key: "com.brave.Browser", name: "Brave" },
      99: { key: "com.apple.TextEdit", name: "TextEdit" },
    });
    await computerUsePlugin(fake.bb);

    // Deny blocks the call without granting the thread.
    const deniedCall = fake.harness.runCli(
      ["call", "click", '{"pid":42,"delivery_mode":"foreground"}'],
      { threadId: "thr_1" },
    );
    await vi.waitFor(() => expect(fake.harness.pendingInteractions).toHaveLength(1));
    fake.harness.submitInteraction(fake.harness.pendingInteractions[0]!.id, { decision: "deny" });
    const denied = await deniedCall;
    expect(denied.exitCode).toBe(1);
    expect(JSON.parse(denied.stdout ?? "").error).toBe("app_denied");

    // Allow for this thread covers all subsequent apps, foreground calls, cursor moves, and clipboard in that thread.
    const firstAllowed = fake.harness.runCli(
      ["call", "bring_to_front", '{"pid":42,"window_id":7}'],
      { threadId: "thr_1" },
    );
    await vi.waitFor(() => expect(fake.harness.pendingInteractions).toHaveLength(1));
    fake.harness.submitInteraction(fake.harness.pendingInteractions[0]!.id, { decision: "thread" });
    expect((await firstAllowed).exitCode).toBe(0);

    for (const argv of [
      ["call", "type_text", '{"pid":42,"text":"hi","delivery_mode":"foreground"}'],
      ["call", "click", '{"pid":99}'],
      ["call", "move_cursor", '{"x":10,"y":20}'],
      ["call", "clipboard_read", "{}"],
    ]) {
      expect((await fake.harness.runCli(argv, { threadId: "thr_1" })).exitCode).toBe(0);
    }
    expect(fake.harness.pendingInteractions).toHaveLength(0);

    // Ending the turn releases app locks while keeping the thread grant.
    await fake.harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_1", projectId: "proj_1" }),
      lastAssistantText: "Done",
    });
    expect(await fake.bb.storage.kv.get("thread-granted/thr_1")).toBe(true);

    // A different thread still asks independently.
    const otherThread = fake.harness.runCli(["call", "click", '{"pid":42}'], { threadId: "thr_2" });
    await vi.waitFor(() => expect(fake.harness.pendingInteractions).toHaveLength(1));
    fake.harness.submitInteraction(fake.harness.pendingInteractions[0]!.id, { decision: "deny" });
    expect((await otherThread).exitCode).toBe(1);

    // Archiving clears the thread grant.
    await fake.harness.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "thr_1", projectId: "proj_1" }),
    });
    expect(await fake.bb.storage.kv.get("thread-granted/thr_1")).toBeUndefined();
  });

  it("persists an approval clicked after the 90s approval_pending timeout", async () => {
    vi.useFakeTimers();
    try {
      const fake = setup();
      await computerUsePlugin(fake.bb);

      const first = fake.harness.runCli(["call", "click", '{"pid":42}'], { threadId: "thr_1" });
      await vi.waitFor(() => expect(fake.harness.pendingInteractions).toHaveLength(1));
      const cardId = fake.harness.pendingInteractions[0]!.id;

      await vi.advanceTimersByTimeAsync(90_000);
      const pendingResult = await first;
      expect(pendingResult.exitCode).toBe(3);
      expect(JSON.parse(pendingResult.stdout ?? "").error).toBe("approval_pending");

      // User clicks Allow after the CLI already returned approval_pending.
      fake.harness.submitInteraction(cardId, { decision: "thread" });
      await vi.waitFor(async () =>
        expect(await fake.bb.storage.kv.get("thread-granted/thr_1")).toBe(true),
      );

      // Next call goes straight through with no new card.
      const retry = await fake.harness.runCli(["call", "click", '{"pid":42}'], { threadId: "thr_1" });
      expect(retry.exitCode).toBe(0);
      expect(fake.harness.pendingInteractions).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to control Cloudroom itself (and its helpers), even in a granted thread", async () => {
    expect(isCloudroomApp("dev.cloudroom.gui")).toBe(true);
    expect(isCloudroomApp("dev.cloudroom.gui.helper")).toBe(true);
    expect(isCloudroomApp("com.github.Electron", "com.github.Electron")).toBe(false);

    const fake = setup({
      42: { key: "dev.cloudroom.gui", name: "Cloudroom" },
      43: { key: "dev.cloudroom.gui.helper.Renderer", name: "Cloudroom Helper" },
      44: { key: "com.github.Electron", name: "Electron" },
    });
    await fake.bb.storage.kv.set("thread-granted/thr_1", true);
    await computerUsePlugin(fake.bb);

    for (const pid of [42, 43]) {
      const blocked = await fake.harness.runCli(["call", "click", JSON.stringify({ pid })], {
        threadId: "thr_1",
      });
      expect(blocked.exitCode).toBe(1);
      expect(JSON.parse(blocked.stdout ?? "").error).toBe("app_blocked");
    }
    expect(
      fake.harness.experimental_hostRpcCalls.filter((call) => call.method === "call"),
    ).toHaveLength(0);

    // Cloudroom Dev (com.github.Electron) is still allowed for QA.
    const dev = await fake.harness.runCli(["call", "click", '{"pid":44}'], { threadId: "thr_1" });
    expect(dev.exitCode).toBe(0);
  });

  it("lists granted threads in Settings, prunes archived ones, and revokes on demand", async () => {
    const threads: Record<string, { title?: string; archivedAt?: number | null; host: { id: string } }> = {
      thr_active: { title: "AWS KMS setup", host: { id: "mac" } },
      thr_old: { title: "Old task", archivedAt: 123, host: { id: "mac" } },
    };
    const fake = createFakePluginHost({
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => threads[threadId] ?? { host: { id: "mac" } },
        },
        hosts: { list: async () => [{ id: "mac", status: "connected" }] },
      },
      experimental_callHostRpc: ({ method }) => {
        if (method === "prepare") return { ...readyStatus, installMs: null };
        if (method === "status") return readyStatus;
        if (method === "appForPid") return { key: "com.brave.Browser", name: "Brave" };
        if (method === "call") return { exitCode: 0, stdout: "{}", stderr: "", driverExits: 0 };
        return null;
      },
    });
    await fake.bb.storage.kv.set("thread-granted/thr_active", true);
    await fake.bb.storage.kv.set("thread-granted/thr_old", true);
    await computerUsePlugin(fake.bb);

    expect(await fake.harness.callRpc("getSettings", null)).toMatchObject({
      grantedThreads: [{ threadId: "thr_active", title: "AWS KMS setup" }],
    });
    expect(await fake.bb.storage.kv.get("thread-granted/thr_old")).toBeUndefined();

    expect(
      await fake.harness.callRpc("revokeThread", { threadId: "thr_active" }),
    ).toMatchObject({ grantedThreads: [] });
    expect(await fake.bb.storage.kv.get("thread-granted/thr_active")).toBeUndefined();

    // Legacy "always" decision still grants the thread.
    const nextCall = fake.harness.runCli(["call", "click", '{"pid":42}'], { threadId: "thr_active" });
    await vi.waitFor(() => expect(fake.harness.pendingInteractions).toHaveLength(1));
    fake.harness.submitInteraction(fake.harness.pendingInteractions[0]!.id, { decision: "always" });
    expect((await nextCall).exitCode).toBe(0);
    expect(await fake.bb.storage.kv.get("thread-granted/thr_active")).toBe(true);
  });
});

it("pruneOldVersions removes sibling driver versions and keeps the active one and staging dirs", async () => {
  const root = await mkdtemp(join(tmpdir(), "cua-prune-"));
  try {
    await mkdir(join(root, "0.35.2"));
    await mkdir(join(root, "0.55.0"));
    await mkdir(join(root, ".install-abc"));
    await pruneOldVersions(join(root, "0.55.0"));
    expect((await readdir(root)).sort()).toEqual([".install-abc", "0.55.0"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// #2745: ordinary Mac launch_app must confirm user-home prelaunch instead of falling back to the driver's private HOME.
it("Mac launch_app requires confirmed user-home prelaunch and preserves bypass flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "cua-prelaunch-"));
  const driverDir = join(root, "cua-driver", DRIVER.version);
  await mkdir(driverDir, { recursive: true });
  await writeFile(join(driverDir, "cua-driver"), "#!/bin/sh\n");
  const sha = createHash("sha256").update("#!/bin/sh\n").digest("hex");
  await writeFile(
    join(driverDir, "verified.json"),
    JSON.stringify({ sha256: sha }),
  );
  const privateHome = join(root, "home");
  const launcherHomes: Array<string | undefined> = [];
  const driverHomes: Array<string | undefined> = [];
  let launcherReply: () => Promise<string> = async () => "launched";
  const servers: ReturnType<typeof createServer>[] = [];
  const origPlatform = process.platform;
  Object.defineProperty(process, "platform", {
    value: "darwin",
    configurable: true,
  });
  proc.execFile = async (file, _args, options) => {
    if (file === "/usr/bin/osascript") {
      launcherHomes.push(options?.env?.HOME);
      return { stdout: `${await launcherReply()}\n`, stderr: "" };
    }
    if (file.endsWith("/cua-driver")) {
      driverHomes.push(options?.env?.HOME);
      return { stdout: JSON.stringify({ pid: 42 }), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  proc.spawn = (_file, args) => {
    const sock = args[args.indexOf("--socket") + 1];
    if (sock) {
      const server = createServer((s) => s.end());
      server.listen(sock);
      servers.push(server);
    }
    const fakeChild = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as string | null,
      stdin: new EventEmitter(),
      kill() {
        fakeChild.exitCode = 0;
        fakeChild.emit("exit", 0);
      },
    });
    return fakeChild;
  };
  const entry = createHostEntry();
  const ctx = {
    signal: new AbortController().signal,
    lifecycle: { signal: new AbortController().signal },
    experimental_paths: { dataDir: root, tempDir: root },
    experimental_retainWorker: () => ({ dispose: async () => undefined }),
  } as Parameters<typeof entry.handlers.call>[1];
  const launch = async (args: Record<string, unknown>) => {
    launcherHomes.length = 0;
    driverHomes.length = 0;
    return entry.handlers.call(
      { tool: "launch_app", args, session: "s1", shotsKey: "thr_1" },
      ctx,
    );
  };
  try {
    // Already-running and freshly prelaunched apps use the user's HOME, then hand off to the driver's private HOME.
    for (const status of ["running", "launched"]) {
      launcherReply = async () => status;
      const res = await launch({ bundle_id: "com.apple.TextEdit" });
      expect(res.exitCode, status).toBe(0);
      expect(launcherHomes, status).toEqual([homedir()]);
      expect(driverHomes, status).toEqual([privateHome]);
    }
    // Failed, timed-out, exited, or unlocated prelaunches must error and never call the driver.
    const failures: Array<[string, () => Promise<string>]> = [
      ["timeout", async () => "timeout"],
      ["exited", async () => "exited"],
      ["not_found", async () => "not_found"],
      [
        "throw",
        async () => {
          throw Object.assign(new Error("boom"), { stderr: "jxa failed" });
        },
      ],
    ];
    for (const [label, reply] of failures) {
      launcherReply = reply;
      const res = await launch({ bundle_id: "com.example.App" });
      expect(res.exitCode, label).toBe(1);
      expect(JSON.parse(res.stdout).error, label).toBe("launch_failed");
      expect(driverHomes, label).toEqual([]);
    }
    // Explicit inspector, new-instance, and extra-argument launches bypass prelaunch and keep the driver's private HOME.
    launcherReply = async () => {
      throw new Error("bypass should not call osascript");
    };
    for (const args of [
      { bundle_id: "com.example.App", webkit_inspector_port: 9222 },
      { bundle_id: "com.example.App", creates_new_application_instance: true },
      { bundle_id: "com.example.App", additional_arguments: ["--incognito"] },
    ]) {
      const res = await launch(args);
      expect(res.exitCode).toBe(0);
      expect(launcherHomes).toEqual([]);
      expect(driverHomes).toEqual([privateHome]);
    }
  } finally {
    await entry.dispose?.();
    for (const server of servers) server.close();
    proc.execFile = null;
    proc.spawn = null;
    Object.defineProperty(process, "platform", {
      value: origPlatform,
      configurable: true,
    });
    await rm(root, { recursive: true, force: true });
  }
});

describe("browser new-window and separate-instance guards", () => {
  const brave = { key: "com.brave.Browser", name: "Brave Browser" };
  const textEdit = { key: "com.apple.TextEdit", name: "TextEdit" };

  it("blocks new browser windows/instances across hotkey, press_key, invoke_menu, and launch_app", () => {
    for (const id of [
      "com.brave.Browser",
      "com.apple.SafariTechnologyPreview",
      "org.mozilla.firefoxdeveloperedition",
      "com.operasoftware.OperaGX",
      "brave-browser",
    ])
      expect(isBrowserApp(id), id).toBe(true);
    expect(isBrowserApp("com.apple.TextEdit")).toBe(false);

    expect(
      blockedBrowserAction({
        tool: "launch_app",
        input: { creates_new_application_instance: true },
        app: brave,
        platform: "darwin",
      }),
    ).toMatch(/second Brave Browser instance/);
    expect(
      blockedBrowserAction({
        tool: "invoke_menu",
        input: { path: ["File", "New Window"] },
        app: brave,
        platform: "darwin",
      }),
    ).toMatch(/New Window/);
    expect(
      blockedBrowserAction({
        tool: "hotkey",
        input: { keys: ["cmd", "n"] },
        app: brave,
        platform: "darwin",
      }),
    ).toMatch(/cmd\+n/);
    expect(
      blockedBrowserAction({
        tool: "press_key",
        input: { key: "n", modifiers: ["cmd"] },
        app: brave,
        platform: "darwin",
      }),
    ).toMatch(/cmd\+n/);
    expect(
      blockedBrowserAction({
        tool: "press_key",
        input: { key: "ctrl+shift+n" },
        app: brave,
        platform: "linux",
      }),
    ).toMatch(/ctrl\+t/);

    for (const allowed of [
      { tool: "invoke_menu", input: { path: ["File", "New Tab"] }, app: brave, platform: "darwin" },
      { tool: "hotkey", input: { keys: ["cmd", "t"] }, app: brave, platform: "darwin" },
      { tool: "press_key", input: { key: "n" }, app: brave, platform: "darwin" },
      { tool: "press_key", input: { key: "n", modifiers: ["ctrl"] }, app: brave, platform: "darwin" },
      { tool: "hotkey", input: { keys: ["cmd", "n"] }, app: textEdit, platform: "darwin" },
    ])
      expect(blockedBrowserAction(allowed)).toBeNull();
  });

  it("gates browser_prepare(allow_launch) without Accessibility or cross-thread app lock", async () => {
    expect(
      decideGate({
        tool: "browser_prepare",
        input: { allow_launch: true, profile: { mode: "isolated_new" } },
      }),
    ).toEqual({ kind: "isolated_browser" });

    const status = {
      platform: "linux",
      supported: true,
      reason: null,
      version: "0",
      installed: true,
      running: true,
      permissions: { accessibility: false, screenRecording: true },
    };
    const replies: Record<string, unknown> = {
      prepare: { ...status, installMs: null },
      status,
      call: { exitCode: 0, stdout: "{}", stderr: "", driverExits: 0 },
    };
    const fake = createFakePluginHost({
      sdk: { threads: { get: async () => ({ host: { id: "linux" } }) } },
      experimental_callHostRpc: ({ method }) => replies[method],
    });
    await fake.bb.storage.kv.set("thread-granted/thr_1", true);
    await fake.bb.storage.kv.set("thread-granted/thr_2", true);
    await computerUsePlugin(fake.bb);
    const launch = ["call", "browser_prepare", '{"allow_launch":true,"profile":{"mode":"isolated_new"}}'];
    for (const threadId of ["thr_1", "thr_2"])
      expect((await fake.harness.runCli(launch, { threadId })).exitCode).toBe(0);
  });
});

describe("browser control detection and setup", () => {
  const err = (code: string) => Object.assign(new Error(code), { code });

  it("detects default browser, FDA, remote debugging, fallbacks, and Linux Flatpak", async () => {
    const home = "/Users/tester";
    // 1. macOS Brave blocked by FDA -> fullDiskAccess: false, remoteDebugging: null (unknown)
    const fdaBlocked = await inspectBrowserControl({
      platform: "darwin",
      home,
      detectDefault: async () => ({
        bundleId: "com.brave.Browser",
        name: "Brave Browser",
        executablePath: null,
      }),
      readFile: async () => {
        throw err("EPERM");
      },
      probeCdpHttp: async () => false,
    });
    expect(fdaBlocked).toMatchObject({
      supported: true,
      browserName: "Brave Browser",
      isDefault: true,
      inspectUrl: "brave://inspect/#remote-debugging",
      fullDiskAccess: false,
      remoteDebugging: null,
      ready: false,
    });

    // 2. macOS Brave FDA granted, DevToolsActivePort live -> ready: true
    const ready = await inspectBrowserControl({
      platform: "darwin",
      home,
      detectDefault: async () => ({
        bundleId: "com.brave.Browser",
        name: "Brave Browser",
        executablePath: null,
      }),
      readFile: async () => "9444\n/devtools/browser/abc\n",
      probeTcp: async (port) => port === 9444,
    });
    expect(ready).toMatchObject({
      supported: true,
      fullDiskAccess: true,
      remoteDebugging: true,
      ready: true,
    });

    // 3. macOS Brave FDA granted, DevToolsActivePort missing -> remoteDebugging: false
    const debugOff = await inspectBrowserControl({
      platform: "darwin",
      home,
      detectDefault: async () => ({
        bundleId: "com.brave.Browser",
        name: "Brave Browser",
        executablePath: null,
      }),
      readFile: async () => {
        throw err("ENOENT");
      },
      readdir: async () => ["Local State"],
      accessReadable: async () => undefined,
      probeCdpHttp: async () => false,
    });
    expect(debugOff).toMatchObject({
      fullDiskAccess: true,
      remoteDebugging: false,
      ready: false,
    });

    // 4. macOS Safari default with no Chromium installed -> unsupported
    const safariOnly = await inspectBrowserControl({
      platform: "darwin",
      home,
      detectDefault: async () => ({
        bundleId: "com.apple.Safari",
        name: "Safari",
        executablePath: null,
      }),
      readdir: async () => {
        throw err("ENOENT");
      },
    });
    expect(safariOnly).toMatchObject({
      supported: false,
      browserName: "Safari",
      ready: false,
    });

    // 5. Fallback port 9222 live works even when DevToolsActivePort is EPERM
    const fallbackPort = await inspectBrowserControl({
      platform: "darwin",
      home,
      detectDefault: async () => ({
        bundleId: "com.google.Chrome",
        name: "Google Chrome",
        executablePath: null,
      }),
      readFile: async () => {
        throw err("EPERM");
      },
      probeCdpHttp: async (port) => port === 9222,
    });
    expect(fallbackPort).toMatchObject({
      supported: true,
      fullDiskAccess: false,
      remoteDebugging: true,
      ready: true,
    });

    // 6. Linux Brave Origin desktop ID doesn't get swallowed by Brave, and Flatpak Chrome works
    const linuxOrigin = await inspectBrowserControl({
      platform: "linux",
      home: "/home/tester",
      detectDefault: async () => ({
        bundleId: "brave-browser-origin.desktop",
        name: "brave-browser-origin",
        executablePath: null,
      }),
      readFile: async (p) =>
        p.includes("Brave-Origin/DevToolsActivePort")
          ? "9555\n/ws\n"
          : Promise.reject(err("ENOENT")),
      probeTcp: async (port) => port === 9555,
    });
    expect(linuxOrigin).toMatchObject({
      supported: true,
      browserName: "Brave Origin",
      ready: true,
    });

    const linuxFlatpak = await inspectBrowserControl({
      platform: "linux",
      home: "/home/tester",
      detectDefault: async () => ({
        bundleId: "firefox.desktop",
        name: "firefox",
        executablePath: null,
      }),
      readdir: async (p) =>
        p.includes(".var/app/com.google.Chrome/config/google-chrome")
          ? ["DevToolsActivePort"]
          : Promise.reject(err("ENOENT")),
      readFile: async (p) =>
        p.includes(
          ".var/app/com.google.Chrome/config/google-chrome/DevToolsActivePort",
        )
          ? "9666\n/ws\n"
          : Promise.reject(err("ENOENT")),
      probeTcp: async (port) => port === 9666,
    });
    expect(linuxFlatpak).toMatchObject({
      supported: true,
      browserName: "Google Chrome",
      isDefault: false,
      ready: true,
    });
  });

  it("setup --browser fails fast on unsupported browser, aborts stale cards on ready, and handles dismiss", async () => {
    const baseStatus = {
      platform: "darwin",
      supported: true,
      reason: null,
      version: "0.55.0",
      installed: true,
      running: false,
      permissions: { accessibility: true, screenRecording: true },
    };
    let currentBrowserControl = {
      supported: false,
      browserName: "Safari",
      shortName: "Safari",
      bundleId: "com.apple.Safari",
      isDefault: true,
      inspectUrl: "chrome://inspect/#remote-debugging",
      fullDiskAccess: null as boolean | null,
      remoteDebugging: null as boolean | null,
      ready: false,
      reason: "Safari doesn't support background browser control." as string | null,
    };
    const fake = createFakePluginHost({
      sdk: { threads: { get: async () => ({ host: { id: "mac" } }) } },
      experimental_callHostRpc: ({ method }) =>
        method === "status"
          ? { ...baseStatus, browserControl: currentBrowserControl }
          : null,
    });
    await computerUsePlugin(fake.bb);

    // Unsupported browser fails fast without creating a card.
    const unsupported = await fake.harness.runCli(["setup", "--browser"], {
      threadId: "thr_1",
    });
    expect(unsupported.exitCode).toBe(1);
    expect(JSON.parse(unsupported.stdout ?? "").error).toBe("unsupported");
    expect(fake.harness.pendingInteractions).toEqual([]);

    // Supported but not ready opens the inline card; dismiss ends cleanly.
    currentBrowserControl = {
      supported: true,
      browserName: "Brave Browser",
      shortName: "Brave",
      bundleId: "com.brave.browser",
      isDefault: true,
      inspectUrl: "brave://inspect/#remote-debugging",
      fullDiskAccess: false,
      remoteDebugging: null,
      ready: false,
      reason: "macOS blocks Brave's debug port without Full Disk Access.",
    };
    const dismissedCall = fake.harness.runCli(["setup", "--browser"], {
      threadId: "thr_1",
    });
    await vi.waitFor(() =>
      expect(fake.harness.pendingInteractions).toHaveLength(1),
    );
    expect(fake.harness.pendingInteractions[0]?.rendererId).toBe(
      "computer-use-browser-setup",
    );
    fake.harness.submitInteraction(fake.harness.pendingInteractions[0]!.id, {
      action: "dismiss",
    });
    const dismissed = await dismissedCall;
    expect(dismissed.exitCode).toBe(1);
    expect(JSON.parse(dismissed.stdout ?? "").error).toBe("setup_dismissed");

    // If a card is still open when the user fixes settings and setup --browser runs again, abort the stale card.
    const pendingCall = fake.harness.runCli(["setup", "--browser"], {
      threadId: "thr_2",
    });
    await vi.waitFor(() =>
      expect(fake.harness.pendingInteractions).toHaveLength(1),
    );
    currentBrowserControl = {
      ...currentBrowserControl,
      fullDiskAccess: true,
      remoteDebugging: true,
      ready: true,
      reason: null,
    };
    const readyResult = await fake.harness.runCli(["setup", "--browser"], {
      threadId: "thr_2",
    });
    expect(readyResult.exitCode).toBe(0);
    expect(JSON.parse(readyResult.stdout ?? "").ready).toBe(true);
    expect(fake.harness.pendingInteractions).toEqual([]);
    const cancelled = await pendingCall;
    expect(JSON.parse(cancelled.stdout ?? "").error).toBe("setup_cancelled");
  });
});
