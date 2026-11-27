import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { assetFor } from "./driver.js";
import {
  driverEnv,
  install,
  pruneOldVersions,
  reconcileBringToFront,
  unsupportedGnomeHint,
  workingXauthority,
} from "./host.js";
import computerUsePlugin, { decideGate, takesForeground } from "./server.js";

const disk = vi.hoisted(() => ({ full: false }));
vi.mock("node:fs", async (actual) => {
  const fs = await actual<typeof import("node:fs")>();
  const enospc = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", syscall: "write" });
  const full = () => new Writable({ write: (_chunk, _encoding, done) => done(enospc) });
  return { ...fs, createWriteStream: ((...args) => (disk.full ? full() : fs.createWriteStream(...args))) as typeof fs.createWriteStream };
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

it("keeps an approval saved with the bundle ID in another case", async () => {
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
  await fake.bb.storage.kv.set("always-allowed", [
    { key: "com.apple.textedit", name: "TextEdit" },
  ]);
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
  const clipboard = { key: "clipboard", name: "the clipboard" };
  await fake.bb.storage.kv.set("always-allowed", [clipboard]);
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
    await fake.bb.storage.kv.set("always-allowed", [
      { key: "com.brave.browser", name: "Brave" },
    ]);
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

describe("foreground focus gate", () => {
  const readyStatus = {
    platform: "darwin",
    supported: true,
    reason: null,
    version: "0.55.0",
    installed: true,
    running: true,
    permissions: { accessibility: true, screenRecording: true },
  };

  it("identifies foreground calls", () => {
    expect(takesForeground("bring_to_front", { pid: 1 })).toBe(true);
    expect(takesForeground("move_cursor", { x: 1, y: 2 })).toBe(true);
    expect(takesForeground("click", { pid: 1, delivery_mode: "foreground" })).toBe(true);
    expect(takesForeground("click", { pid: 1 })).toBe(false);
    expect(takesForeground("drag", { pid: 1 })).toBe(false);
  });

  it("asks once for foreground calls even on always-allowed apps and blocks on deny", async () => {
    const replies: Record<string, unknown> = {
      prepare: { ...readyStatus, installMs: null },
      status: readyStatus,
      appForPid: { key: "com.brave.Browser", name: "Brave" },
      call: {
        exitCode: 0,
        stdout: JSON.stringify(verified),
        stderr: "",
        driverExits: 0,
      },
    };
    const fake = createFakePluginHost({
      sdk: { threads: { get: async () => ({ host: { id: "mac" } }) } },
      experimental_callHostRpc: ({ method }) => replies[method],
    });
    await fake.bb.storage.kv.set("always-allowed", [{ key: "com.brave.Browser", name: "Brave" }]);
    await computerUsePlugin(fake.bb);

    const deniedCall = fake.harness.runCli(
      ["call", "click", '{"pid":42,"delivery_mode":"foreground"}'],
      { threadId: "thr_1" },
    );
    await vi.waitFor(() => expect(fake.harness.pendingInteractions).toHaveLength(1));
    expect(fake.harness.pendingInteractions[0]?.payload).toMatchObject({ foreground: true });
    fake.harness.submitInteraction(fake.harness.pendingInteractions[0]!.id, { decision: "deny" });
    const denied = await deniedCall;
    expect(denied.exitCode).toBe(1);
    expect(JSON.parse(denied.stdout ?? "").error).toBe("foreground_denied");

    // Allow once succeeds, and a second foreground call still asks again.
    for (let i = 0; i < 2; i++) {
      const allowedCall = fake.harness.runCli(
        ["call", "bring_to_front", '{"pid":42,"window_id":7}'],
        { threadId: "thr_1" },
      );
      await vi.waitFor(() => expect(fake.harness.pendingInteractions).toHaveLength(1));
      fake.harness.submitInteraction(fake.harness.pendingInteractions[0]!.id, { decision: "thread" });
      expect((await allowedCall).exitCode).toBe(0);
    }
    expect(
      fake.harness.experimental_hostRpcCalls
        .filter((call) => call.method === "call")
        .map((call) => (call.input as { tool: string }).tool),
    ).toEqual(["bring_to_front", "bring_to_front"]);
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
