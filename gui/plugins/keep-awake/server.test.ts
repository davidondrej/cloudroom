import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import plugin from "./server.js";

it("looks up at most 6 threads at once, with main's result (#2207)", async () => {
  // 70 working threads on "a"; the only thread on "w" has waited 2 hours on a question.
  const threads = [...Array.from({ length: 70 }, (_, i) => ({ id: `a${i}`, hostId: "a" })), { id: "w", hostId: "w" }];
  const counts = { open: 0, max: 0 };
  const list = async ({ threadId }: { threadId: string }) => {
    counts.max = Math.max(counts.max, ++counts.open);
    await new Promise((resolve) => setTimeout(resolve, 5));
    counts.open--;
    return threadId === "w" ? [{ createdAt: Date.now() - 2 * 60 * 60_000 }] : [];
  };
  const hosts = [{ id: "a", status: "connected" }, { id: "w", status: "connected" }];
  const sent: Record<string, string> = {};
  const { bb, harness } = createFakePluginHost({
    pluginId: "keep-awake",
    sdk: { subscribe: () => () => {}, hosts: { list: async () => hosts as never }, threads: { listRunning: async () => threads, interactions: { list } as never } },
    experimental_callHostRpc: async ({ hostId, input }) => ((sent[hostId] = (input as { state: string }).state), { state: sent[hostId], supported: true }),
  });
  await plugin(bb);
  harness.runService("desired-state-reconciler");
  await vi.waitFor(() => expect(sent).toEqual({ a: "awake", w: "off" }));
  expect(counts.max).toBe(6);
});
