import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { Interaction, Thread } from "./rules.js";
import { createPushNotificationsPlugin } from "./server.js";

const COALESCE_MS = 10;

function question(threadId: string, prompt: string): Interaction {
  return {
    id: `interaction-${threadId}`,
    threadId,
    status: "pending",
    statusReason: null,
    createdAt: 1,
    expiresAt: null,
    resolvedAt: null,
    turnId: `turn-${threadId}`,
    providerId: "codex",
    providerThreadId: `provider-${threadId}`,
    providerRequestId: `request-${threadId}`,
    origin: {
      kind: "provider",
      providerId: "codex",
      providerThreadId: `provider-${threadId}`,
      providerRequestId: `request-${threadId}`,
    },
    payload: {
      kind: "user_question",
      questions: [
        { id: "question-1", prompt, multiSelect: false, allowFreeText: true },
      ],
    },
    resolution: null,
  };
}

async function setup() {
  const threads = new Map<string, Thread>();
  const interactions = new Map<string, Interaction[]>();
  const fake = createFakePluginHost({
    pluginId: "push-notifications",
    sdk: {
      threads: {
        get: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error("Thread not found");
          return thread;
        },
        interactions: {
          list: async ({ threadId }) => interactions.get(threadId) ?? [],
        },
      },
    },
  });
  await createPushNotificationsPlugin({ coalesceMs: COALESCE_MS })(fake.bb);
  const service = fake.harness.behavior.runService("notifier");
  const { behavior } = fake.harness;
  return {
    behavior,
    interactions,
    signals: fake.harness.realtimeSignals,
    setThread(overrides: Partial<Thread> = {}) {
      const thread = makeThreadResponse({
        id: `thread-${threads.size + 1}`,
        status: "idle",
        title: "Fix the flaky test",
        latestAttentionAt: Date.now() + 60_000,
        ...overrides,
      });
      threads.set(thread.id, thread);
      return thread;
    },
    idle: (thread: Thread, text = "Done") =>
      behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: text,
      }),
    settle: () =>
      new Promise((resolve) => setTimeout(resolve, COALESCE_MS * 4)),
    async cleanup() {
      service.controller.abort();
      await service.done;
      await fake.harness.lifecycle.dispose();
    },
  };
}

describe("push-notifications server", () => {
  it("sends one notification per thread and prefers an open question", async () => {
    const host = await setup();
    try {
      const thread = host.setThread({ status: "active", title: "Release" });
      const open = question(thread.id, "Ship to staging or production?");
      host.interactions.set(thread.id, [open]);
      await host.idle({ ...thread, status: "idle" });
      await host.behavior.emitThreadEvent("interaction.pending", {
        thread,
        interaction: open,
      });

      const answered = host.setThread();
      const closed = question(answered.id, "Continue?");
      await host.behavior.emitThreadEvent("interaction.pending", {
        thread: answered,
        interaction: closed,
      });
      await host.idle(host.setThread({ parentThreadId: "parent-1" }));
      await host.settle();

      expect(host.signals).toEqual([
        {
          channel: "notification",
          payload: {
            id: expect.any(String),
            title: "Release",
            body: "Ship to staging or production?",
            threadId: thread.id,
            channels: ["web", "desktop"],
          },
        },
      ]);
    } finally {
      await host.cleanup();
    }
  });

  it("follows the web and desktop switches", async () => {
    const host = await setup();
    try {
      const thread = host.setThread();
      await host.behavior.setSettings({ webEnabled: false });
      await host.idle(thread);
      await host.settle();
      expect(host.signals.at(-1)?.payload).toMatchObject({
        channels: ["desktop"],
      });
      await host.behavior.setSettings({ desktopEnabled: false });
      await host.idle(thread);
      await host.settle();
      expect(host.signals).toHaveLength(1);
      expect(await host.behavior.runCli(["status", "--json"])).toMatchObject({
        exitCode: 0,
        stdout: JSON.stringify({ webEnabled: false, desktopEnabled: false }),
      });
    } finally {
      await host.cleanup();
    }
  });

  it("routes CLI and RPC tests only to the selected enabled channel", async () => {
    const host = await setup();
    try {
      expect(await host.behavior.runCli(["test", "web"])).toMatchObject({
        exitCode: 0,
      });
      expect(host.signals.at(-1)?.payload).toMatchObject({
        channels: ["web"],
        threadId: null,
      });
      await host.behavior.callRpc("notifications.test", { channel: "desktop" });
      expect(host.signals.at(-1)?.payload).toMatchObject({
        channels: ["desktop"],
      });
      await host.behavior.setSettings({ desktopEnabled: false });
      expect(await host.behavior.runCli(["test", "desktop"])).toMatchObject({
        exitCode: 1,
      });
      await expect(
        host.behavior.callRpc("notifications.test", { channel: "desktop" }),
      ).rejects.toThrow("disabled");
      await expect(
        host.behavior.callRpc("notifications.test", { channel: "ios" }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(await host.behavior.runCli(["add"])).toMatchObject({
        exitCode: 1,
      });
      expect(host.signals).toHaveLength(2);
    } finally {
      await host.cleanup();
    }
  });
});
