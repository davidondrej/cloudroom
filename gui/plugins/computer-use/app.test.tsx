// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

afterEach(cleanup);

const permissions = { accessibility: false, screenRecording: false };

function render() {
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
          alwaysAllowed: [],
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

it("asks macOS for permission on Grant without allowing the app", async () => {
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
  ["Always allow", "always"],
  ["Only this thread", "thread"],
  ["Deny", "deny"],
])("%s sends its own decision", (name, decision) => {
  const { slot, submit } = render();
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
