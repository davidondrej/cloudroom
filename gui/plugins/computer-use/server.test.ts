import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import computerUsePlugin, { acceptFocusedWindow, decideGate } from "./server.js";

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

// Cua Driver 0.35.2's exact_result for #1506: focused, but a 41 px Chrome helper is front in-process.
const unverified = {
  status: "partial",
  code: "bring_to_front_exact_window_unverified",
  pid: 42,
  window_id: 7,
  activated: false,
  process_activated: true,
  exact_window_effect: { verified: false, focused: true, front_in_process_on_display: false, target_visible_ordinary: true },
  observed: { frontmost_pid: 42, front_process_matches_target: true, focused_window_id: 7, process_front_window_on_display: 9 },
};
const win = (window_id: number, z_index: number, title: string, width: number, height: number) => ({
  window_id, pid: 42, title, z_index, is_on_screen: true, layer: 0, bounds: { x: 0, y: 0, width, height },
});
const document = win(7, 5, "Docs", 1400, 900);
const helpers = [document, win(8, 6, "", 1400, 41), win(9, 7, "", 1400, 41)];

it.each([
  ["only 41 px untitled helpers on top", {}, { pid: 42, window_id: 7 }, helpers, 0],
  ["full titled sibling on top", {}, { pid: 42, window_id: 7 }, [document, win(9, 7, "Other tab", 1400, 900)], 1],
  ["target off screen", {}, { pid: 42, window_id: 7 }, [{ ...document, is_on_screen: false }, ...helpers.slice(1)], 1],
  ["not focused", { exact_window_effect: { ...unverified.exact_window_effect, focused: false } }, { pid: 42, window_id: 7 }, helpers, 1],
  ["another window focused", { observed: { ...unverified.observed, focused_window_id: 9 } }, { pid: 42, window_id: 7 }, helpers, 1],
  ["front process unknown", { observed: { ...unverified.observed, front_process_matches_target: null } }, { pid: 42, window_id: 7 }, helpers, 1],
  ["another window requested", {}, { pid: 42, window_id: 8 }, helpers, 1],
])("bring_to_front unverified: %s", async (_name, patch, input, windows, exitCode) => {
  const stdout = JSON.stringify({ ...unverified, ...patch });
  const list = async () => ({ exitCode: 0, stdout: JSON.stringify({ windows }) });
  const result = await acceptFocusedWindow("bring_to_front", input, { exitCode: 1, stdout, stderr: "" }, list);
  expect(result.exitCode).toBe(exitCode);
  if (exitCode === 1) expect(result.stdout).toBe(stdout);
  else expect(JSON.parse(result.stdout ?? "")).toMatchObject({ status: "activated", activated: true, code: "bring_to_front_exact_window_focused", exact_window_effect: { verified: false } });
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
