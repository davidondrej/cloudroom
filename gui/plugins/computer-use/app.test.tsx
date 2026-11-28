// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

afterEach(cleanup);

const permissions = { accessibility: false, screenRecording: false };

function render(extra: Record<string, unknown> = {}) {
  const submit = vi.fn(async () => undefined);
  const slot = renderSlot(
    app.pendingInteractions[0]!,
    {
      interaction: {
        id: "pint_test",
        threadId: "thr_test",
        title: "Allow Safari?",
        payload: {
          app: { key: "com.apple.Safari", name: "Safari" },
          tool: "click",
          purpose: null,
          platform: "darwin",
          permissions,
          ...extra,
        },
        createdAt: 0,
        expiresAt: null,
      },
      submit,
      cancel: async () => undefined,
    },
    {
      rpc: {
        requestPermission: async () => ({
          hostId: null,
          status: {
            platform: "darwin",
            supported: true,
            reason: null,
            version: "0.1.0",
            installed: true,
            running: true,
            permissions: { ...permissions, accessibility: true },
          },
          error: null,
          grantedThreads: [],
        }),
      },
    },
  );
  return { slot, submit };
}

it("opens with no choice focused", () => {
  render();
  expect(document.activeElement).toBe(document.body);
});

it("asks macOS for permission on Grant without allowing the thread", async () => {
  const { slot, submit } = render();
  fireEvent.click(slot.getAllByRole("button", { name: "Grant" })[0]!);
  await waitFor(() =>
    expect(
      slot.queryByText("Cloudroom needs macOS permission first."),
    ).toBeNull(),
  );
  expect(slot.rpcCalls).toContainEqual({
    method: "requestPermission",
    input: { kind: "accessibility" },
  });
  expect(submit).not.toHaveBeenCalled();
});

it.each([
  ["Allow for this thread", "thread"],
  ["Deny", "deny"],
])("%s sends its own decision", (name, decision) => {
  const { slot, submit } = render();
  expect(slot.queryByRole("button", { name: "Always allow" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name }));
  expect(submit).toHaveBeenCalledExactlyOnceWith({ decision });
});

it("denies on Escape", () => {
  const { slot, submit } = render();
  fireEvent.keyDown(slot.getByRole("button", { name: "Deny" }), {
    key: "Escape",
  });
  expect(submit).toHaveBeenCalledExactlyOnceWith({ decision: "deny" });
});

it("lists granted threads in Settings and revokes one on click", async () => {
  const baseStatus = {
    platform: "darwin",
    supported: true,
    reason: null,
    version: "0.59.5",
    installed: true,
    running: false,
    permissions: { accessibility: true, screenRecording: true },
  };
  const slot = renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        getSettings: async () => ({
          hostId: "mac",
          status: baseStatus,
          error: null,
          grantedThreads: [{ threadId: "thr_abc", title: "AWS KMS setup" }],
        }),
        revokeThread: async () => ({
          hostId: "mac",
          status: baseStatus,
          error: null,
          grantedThreads: [],
        }),
      },
    },
  );
  await waitFor(() => expect(slot.getByText("AWS KMS setup")).toBeTruthy());
  fireEvent.click(slot.getByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(slot.getByText("None yet.")).toBeTruthy());
  expect(slot.rpcCalls).toContainEqual({
    method: "revokeThread",
    input: { threadId: "thr_abc" },
  });
});
