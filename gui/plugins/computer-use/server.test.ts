import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import computerUsePlugin, { decideGate } from "./server.js";

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
