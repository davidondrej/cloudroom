// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

afterEach(cleanup);

function render() {
  const submit = vi.fn(async () => undefined);
  const slot = renderSlot(app.pendingInteractions[0]!, {
    interaction: {
      id: "pint_test",
      threadId: "thr_test",
      title: "Use a GPU?",
      payload: {
        gpu: "1x H100 80 GB",
        name: "H100",
        count: 1,
        cpu: 8,
        memory: 48,
        disk: 100,
        hours: 2,
        purpose: "Fine-tune the classifier.",
        credits_per_hour: 10_261,
        max_credits: 20_522,
        credits_left: 131_400,
      },
      createdAt: 0,
      expiresAt: null,
    },
    submit,
    cancel: async () => undefined,
  });
  return { slot, submit };
}

it("opens with no choice focused", () => {
  render();
  expect(document.activeElement).toBe(document.body);
});

it.each([
  ["Approve", { approve: true }],
  ["Deny", { approve: false }],
])("%s sends its own answer", (name, value) => {
  const { slot, submit } = render();
  fireEvent.click(slot.getByRole("button", { name }));
  expect(submit).toHaveBeenCalledExactlyOnceWith(value);
});

it("denies on Escape", () => {
  const { slot, submit } = render();
  fireEvent.keyDown(slot.getByRole("button", { name: "Deny" }), {
    key: "Escape",
  });
  expect(submit).toHaveBeenCalledExactlyOnceWith({ approve: false });
});
