import { setTimeout as sleep } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  events as eventTable,
  getThread,
  hostDaemonSessions,
  listPendingInteractionsByThread,
  markThreadDeleted,
  openSession,
  pendingInteractions as pendingInteractionTable,
} from "@cloudroom/db";
import type { PendingInteractionCreate } from "@cloudroom/domain";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@cloudroom/host-daemon-contract";
import {
  DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS,
  DAEMON_DISCONNECT_GRACE_MS,
} from "../../src/constants.js";
import {
  handleDaemonSocketClosed,
  handleHostSessionOpened,
  startRunningTurnDeadlinesAfterRestart,
} from "../../src/internal/session-owner-side-effects.js";
import { requestThreadStopForCurrentState } from "../../src/services/threads/thread-lifecycle.js";
import {
  archiveThreadAndReleaseChildren,
  unarchiveThreadKeepingOpenParent,
} from "../../src/services/threads/thread-ownership.js";
import { NotificationHub } from "../../src/ws/hub.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";
import { toPendingInteraction } from "../../src/services/interactions/pending-interaction-serialization.js";
import { PendingInteractionLifecycle } from "../../src/services/interactions/pending-interactions.js";
import type { AppDeps } from "../../src/types.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedSession,
  seedThread,
  seedTurnStarted,
} from "../helpers/seed.js";
import {
  createAllowForSessionResolution,
  createAllowOnceResolution,
  createCommandApprovalPayload,
  createDenyResolution,
  createFileChangeApprovalPayload,
  createPermissionGrantApprovalPayload,
  createToolUseApprovalPayload,
  createUserAnswerResolution,
  createUserQuestionPayload,
} from "../helpers/pending-interactions.js";
import { withTestHarness } from "../helpers/test-app.js";

function registerPendingInteraction(
  deps: Pick<AppDeps, "db" | "hub">,
  lifecycle: PendingInteractionLifecycle,
  interaction: PendingInteractionCreate,
) {
  seedTurnStarted(deps, {
    threadId: interaction.threadId,
    turnId: interaction.turnId,
    providerThreadId: interaction.providerThreadId,
  });
  return lifecycle.registerPendingInteraction({
    interaction,
  });
}

function seedPluginInteractionThread(deps: AppDeps, suffix: string) {
  const { host } = seedHostSession(deps, {
    id: `host-plugin-interaction-${suffix}`,
  });
  const { project } = seedProjectWithSource(deps, { hostId: host.id });
  const environment = seedEnvironment(deps, {
    hostId: host.id,
    projectId: project.id,
  });
  return seedThread(deps, {
    projectId: project.id,
    environmentId: environment.id,
  });
}

function requestPluginInteraction(
  deps: AppDeps,
  args: {
    threadId: string;
    name?: string;
    signal?: AbortSignal;
  },
) {
  return deps.pendingInteractions.requestPluginInteraction({
    pluginId: "secrets",
    threadId: args.threadId,
    rendererId: "secret-request",
    title: "Add secrets",
    payload: { fields: [{ name: args.name ?? "API_KEY" }] },
    timeoutMs: 10_000,
    ...(args.signal ? { signal: args.signal } : {}),
  });
}

describe("pending interaction lifecycle", () => {
  it("announces each committed plugin prompt once without read duplicates", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedPluginInteractionThread(harness.deps, "pending-event");
      const emit = vi.spyOn(
        harness.pluginService.events,
        "emitInteractionPending",
      );
      const controller = new AbortController();
      try {
        const pending = requestPluginInteraction(harness.deps, {
          threadId: thread.id,
          signal: controller.signal,
        });
        const [interaction] =
          harness.deps.pendingInteractions.listPendingThreadInteractions(
            thread.id,
          );
        expect(interaction).toMatchObject({
          origin: { kind: "plugin" },
          status: "pending",
          threadId: thread.id,
        });
        expect(emit).toHaveBeenCalledExactlyOnceWith(thread, interaction);
        harness.deps.pendingInteractions.listPendingThreadInteractions(
          thread.id,
        );
        listPendingInteractionsByThread(harness.db, {
          threadId: thread.id,
        }).map(toPendingInteraction);
        expect(emit).toHaveBeenCalledTimes(1);
        controller.abort();
        await expect(pending).resolves.toMatchObject({ outcome: "cancelled" });
      } finally {
        controller.abort();
        emit.mockRestore();
      }
    });
  });

  it("returns a plugin response only through memory and persists metadata only", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedPluginInteractionThread(harness.deps, "memory-only");
      const pending = requestPluginInteraction(harness.deps, {
        threadId: thread.id,
      });
      const [interaction] =
        harness.deps.pendingInteractions.listPendingThreadInteractions(
          thread.id,
        );
      expect(interaction?.payload.kind).toBe("plugin");

      harness.deps.pendingInteractions.respondToPluginInteraction({
        threadId: thread.id,
        interactionId: interaction!.id,
        value: { values: { API_KEY: "sentinel-secret-value" } },
      });

      await expect(pending).resolves.toEqual({
        outcome: "submitted",
        value: { values: { API_KEY: "sentinel-secret-value" } },
      });
      const [stored] = harness.db
        .select()
        .from(pendingInteractionTable)
        .where(eq(pendingInteractionTable.id, interaction!.id))
        .all();
      expect(JSON.stringify(stored)).not.toContain("sentinel-secret-value");
      expect(stored?.resolution).toBe('{"kind":"plugin_submitted"}');
      expect(
        JSON.stringify(harness.db.select().from(eventTable).all()),
      ).not.toContain("sentinel-secret-value");
    });
  });

  it("delivers a plugin response before terminal side effects run", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedPluginInteractionThread(harness.deps, "delivery");
      const pending = requestPluginInteraction(harness.deps, {
        threadId: thread.id,
      });
      const [interaction] =
        harness.deps.pendingInteractions.listPendingThreadInteractions(
          thread.id,
        );
      vi.spyOn(harness.hub, "notifyThread").mockImplementationOnce(() => {
        throw new Error("timeline notification failed");
      });

      expect(
        harness.deps.pendingInteractions.respondToPluginInteraction({
          threadId: thread.id,
          interactionId: interaction!.id,
          value: { values: { API_KEY: "sentinel-secret-value" } },
        }),
      ).toMatchObject({ status: "resolved" });
      await expect(pending).resolves.toEqual({
        outcome: "submitted",
        value: { values: { API_KEY: "sentinel-secret-value" } },
      });
    });
  });

  it("contains abort callback failures and settles the in-memory waiter", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedPluginInteractionThread(harness.deps, "abort");
      const controller = new AbortController();
      const pending = requestPluginInteraction(harness.deps, {
        threadId: thread.id,
        signal: controller.signal,
      });
      vi.spyOn(
        harness.deps.pendingInteractions,
        "cancelPluginInteraction",
      ).mockImplementation(() => {
        throw new Error("cancellation failed");
      });

      expect(() => controller.abort()).not.toThrow();
      await expect(pending).resolves.toEqual({
        outcome: "cancelled",
        reason: "request-aborted",
      });
    });
  });

  it("interrupts a plugin interaction when its creation side effects fail", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedPluginInteractionThread(harness.deps, "setup-failure");
      vi.spyOn(harness.hub, "notifyThread").mockImplementationOnce(() => {
        throw new Error("timeline notification failed");
      });

      await expect(
        Promise.resolve().then(() =>
          requestPluginInteraction(harness.deps, {
            threadId: thread.id,
          }),
        ),
      ).rejects.toThrow("timeline notification failed");
      expect(
        harness.deps.pendingInteractions.listPendingThreadInteractions(
          thread.id,
        ),
      ).toEqual([]);
      expect(
        listPendingInteractionsByThread(harness.db, {
          threadId: thread.id,
        }).map(toPendingInteraction),
      ).toMatchObject([{ status: "interrupted" }]);
    });
  });

  it("settles every plugin waiter before batch terminal side effects", async () => {
    await withTestHarness(async (harness) => {
      const firstThread = seedPluginInteractionThread(harness.deps, "batch-1");
      const secondThread = seedPluginInteractionThread(harness.deps, "batch-2");
      const first = requestPluginInteraction(harness.deps, {
        threadId: firstThread.id,
        name: "FIRST",
      });
      const second = requestPluginInteraction(harness.deps, {
        threadId: secondThread.id,
        name: "SECOND",
      });
      vi.spyOn(harness.hub, "notifyThread").mockImplementationOnce(() => {
        throw new Error("timeline notification failed");
      });

      expect(() =>
        harness.deps.pendingInteractions.interruptPluginInteractions("secrets"),
      ).toThrow("timeline notification failed");
      await expect(Promise.all([first, second])).resolves.toEqual([
        { outcome: "cancelled", reason: "plugin-disposed" },
        { outcome: "cancelled", reason: "plugin-disposed" },
      ]);
    });
  });

  it("includes project and pending state metadata in interaction change notifications", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-notification-metadata",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const notifyThread = vi.spyOn(harness.hub, "notifyThread");

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-notification-metadata-1",
          providerId: "codex",
          providerThreadId: "provider-thread-notification-metadata",
          providerRequestId: "request-notification-metadata",
          payload: createCommandApprovalPayload({
            itemId: "item-notification-metadata-1",
            reason: "Needs approval",
            command: "git status",
            cwd: "/tmp/project",
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      expect(notifyThread).toHaveBeenCalledWith(
        thread.id,
        ["interactions-changed"],
        { hasPendingInteraction: true, projectId: project.id },
      );

      harness.db.transaction((tx) =>
        harness.deps.pendingInteractions.completeResolvingInteractionInTransaction(
          { db: tx, hub: harness.deps.hub },
          {
            interactionId: created.interaction.id,
            resolution: createAllowOnceResolution(),
          },
        ),
      );

      expect(notifyThread).toHaveBeenCalledWith(
        thread.id,
        ["interactions-changed"],
        { hasPendingInteraction: false, projectId: project.id },
      );
    });
  });

  it("skips corrupt rows when listing pending interactions", async () => {
    await withTestHarness(async (harness) => {
      const logger = {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      };
      const lifecycle = new PendingInteractionLifecycle({
        config: harness.deps.config,
        db: harness.db,
        hub: harness.hub,
        lifecycleDedupers: harness.deps.lifecycleDedupers,
        logger,
        machineAuth: harness.deps.machineAuth,
        providerRegistry: harness.deps.providerRegistry,
        aiServices: harness.deps.aiServices,
        pluginHostArtifacts: harness.deps.pluginHostArtifacts,
        skillTreeRegistry: harness.deps.skillTreeRegistry,
        telemetry: harness.deps.telemetry,
        terminalSessions: harness.deps.terminalSessions,
      });
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-corrupt-list",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const corrupt = registerPendingInteraction(harness.deps, lifecycle, {
        threadId: thread.id,
        turnId: "turn-corrupt-list-1",
        providerId: "codex",
        providerThreadId: "provider-thread-corrupt-list",
        providerRequestId: "request-corrupt-list-1",
        payload: createCommandApprovalPayload({
          itemId: "item-corrupt-list-1",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
        }),
      });
      if (corrupt.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${corrupt.reason}`,
        );
      }

      harness.db
        .update(pendingInteractionTable)
        .set({
          status: "resolved",
          resolution: "{",
          resolvedAt: Date.now(),
        })
        .where(eq(pendingInteractionTable.id, corrupt.interaction.id))
        .run();

      const valid = registerPendingInteraction(harness.deps, lifecycle, {
        threadId: thread.id,
        turnId: "turn-corrupt-list-2",
        providerId: "codex",
        providerThreadId: "provider-thread-corrupt-list",
        providerRequestId: "request-corrupt-list-2",
        payload: createCommandApprovalPayload({
          itemId: "item-corrupt-list-2",
          reason: "Needs approval",
          command: "git status",
          cwd: "/tmp/project",
        }),
      });
      if (valid.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${valid.reason}`,
        );
      }
      harness.db
        .update(pendingInteractionTable)
        .set({ status: "resolving", resolvedAt: null })
        .where(eq(pendingInteractionTable.id, corrupt.interaction.id))
        .run();

      expect(lifecycle.listPendingThreadInteractions(thread.id)).toEqual([
        valid.interaction,
      ]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          field: "resolution",
          interactionId: corrupt.interaction.id,
        }),
        "Skipping corrupt pending interaction row",
      );
      expect(() =>
        lifecycle.getThreadInteraction({
          threadId: thread.id,
          interactionId: corrupt.interaction.id,
        }),
      ).toThrow("Stored pending interaction resolution is invalid");
    });
  });

  it("resolves user-question interactions with user answers", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-user-question-answer",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "claude-code",
      });

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-user-question-answer",
          providerId: "claude-code",
          providerThreadId: "provider-thread-user-question-answer",
          providerRequestId: "request-user-question-answer",
          payload: createUserQuestionPayload(),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      const answerResolution = createUserAnswerResolution({
        freeText: "Use staging until QA signs off.",
      });
      const resolving =
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: answerResolution,
        });

      expect(resolving).toMatchObject({
        id: created.interaction.id,
        resolution: answerResolution,
        status: "resolving",
      });

      const completed = harness.db.transaction((tx) =>
        harness.deps.pendingInteractions.completeResolvingInteractionInTransaction(
          { db: tx, hub: harness.deps.hub },
          {
            interactionId: created.interaction.id,
            resolution: answerResolution,
          },
        ),
      );

      expect(completed).toMatchObject({
        id: created.interaction.id,
        resolution: answerResolution,
        status: "resolved",
      });
    });
  });

  it("interrupts pending user-question interactions without orphaning state", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-user-question-interrupted",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "claude-code",
      });

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-user-question-interrupted",
          providerId: "claude-code",
          providerThreadId: "provider-thread-user-question-interrupted",
          providerRequestId: "request-user-question-interrupted",
          payload: createUserQuestionPayload(),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      const interrupted = harness.db.transaction((tx) =>
        harness.deps.pendingInteractions.interruptPendingInteractionInTransaction(
          { db: tx, hub: harness.deps.hub },
          {
            interactionId: created.interaction.id,
            reason: "Provider exited",
          },
        ),
      );

      expect(interrupted).toMatchObject({
        id: created.interaction.id,
        resolution: null,
        status: "interrupted",
        statusReason: "Provider exited",
      });
      expect(() =>
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createUserAnswerResolution(),
        }),
      ).toThrowError(
        `Pending interaction ${created.interaction.id} is already interrupted`,
      );
    });
  });

  it("rejects reused provider request ids after the original interaction is terminal", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-terminal-dedupe",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-terminal-dedupe-1",
          providerId: "codex",
          providerThreadId: "provider-thread-terminal-dedupe",
          providerRequestId: "request-terminal-dedupe",
          payload: createCommandApprovalPayload({
            itemId: "item-terminal-dedupe-1",
            reason: "Needs approval",
            command: "git push",
            cwd: "/tmp/project",
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      harness.deps.pendingInteractions.resolvePendingInteraction({
        threadId: thread.id,
        interactionId: created.interaction.id,
        resolution: createAllowOnceResolution(),
      });
      harness.db.transaction((tx) =>
        harness.deps.pendingInteractions.completeResolvingInteractionInTransaction(
          { db: tx, hub: harness.deps.hub },
          {
            interactionId: created.interaction.id,
            resolution: createAllowOnceResolution(),
          },
        ),
      );

      expect(
        registerPendingInteraction(
          harness.deps,
          harness.deps.pendingInteractions,
          {
            threadId: thread.id,
            turnId: "turn-terminal-dedupe-2",
            providerId: "codex",
            providerThreadId: "provider-thread-terminal-dedupe",
            providerRequestId: "request-terminal-dedupe",
            payload: createCommandApprovalPayload({
              itemId: "item-terminal-dedupe-2",
              reason: "Needs approval again",
              command: "git push",
              cwd: "/tmp/project",
              availableDecisions: ["allow_once", "deny"],
            }),
          },
        ),
      ).toEqual({
        outcome: "rejected",
        reason:
          "Provider request request-terminal-dedupe was already handled and cannot be reused",
      });
    });
  });

  it("deduplicates active provider requests across daemon sessions when payloads match", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-reconnect-dedupe",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const interaction: PendingInteractionCreate = {
        threadId: thread.id,
        turnId: "turn-reconnect-dedupe",
        providerId: "codex",
        providerThreadId: "provider-thread-reconnect-dedupe",
        providerRequestId: "request-reconnect-dedupe",
        payload: createCommandApprovalPayload({
          itemId: "item-reconnect-dedupe",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
        }),
      };

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        interaction,
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      const duplicate = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        interaction,
      );

      expect(duplicate).toEqual({
        outcome: "existing",
        interaction: created.interaction,
      });
    });
  });

  it("preserves pending interactions when the same daemon instance reconnects", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-same-instance-reconnect",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-same-instance-reconnect",
          providerId: "codex",
          providerThreadId: "provider-thread-same-instance-reconnect",
          providerRequestId: "request-same-instance-reconnect",
          payload: createUserQuestionPayload(),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }
      const replacementSession = seedSession(harness.deps, host.id);
      await handleHostSessionOpened(harness.deps, {
        activeThreads: [],
        hostId: host.id,
        openedSession: replacementSession,
        previousSession: session,
      });

      const row = harness.db
        .select()
        .from(pendingInteractionTable)
        .where(eq(pendingInteractionTable.id, created.interaction.id))
        .get();
      expect(row).toMatchObject({
        status: "pending",
        statusReason: null,
      });
    });
  });

  it("keeps a parent question and active children alive through a brief disconnect until the active-work grace expires", async () => {
    await withTestHarness(async (harness) => {
      vi.useFakeTimers();
      try {
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-pending-interaction-brief-disconnect",
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
        });
        const parent = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          providerId: "claude-code",
          status: "active",
        });
        const children = [1, 2].map((index) => {
          const child = seedThread(harness.deps, {
            projectId: project.id,
            environmentId: environment.id,
            parentThreadId: parent.id,
            providerId: "claude-code",
            status: "active",
          });
          seedTurnStarted(harness.deps, {
            environmentId: environment.id,
            threadId: child.id,
            turnId: `turn-child-${index}`,
          });
          return child;
        });
        const created = registerPendingInteraction(
          harness.deps,
          harness.deps.pendingInteractions,
          {
            threadId: parent.id,
            turnId: "turn-parent-brief-disconnect",
            providerId: "claude-code",
            providerThreadId: "claude-parent-brief-disconnect",
            providerRequestId: "ask-parent-brief-disconnect",
            payload: createUserQuestionPayload(),
          },
        );
        if (created.outcome === "rejected") {
          throw new Error(
            `Expected interaction registration to succeed: ${created.reason}`,
          );
        }
        harness.deps.hub.registerDaemon(
          session.id,
          host.id,
          createMockHubSocket(),
        );

        handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
        await vi.advanceTimersByTimeAsync(DAEMON_DISCONNECT_GRACE_MS + 5_000);

        // Past the 5s disconnect grace, the question and all turns still wait for reconnect.
        expect(
          harness.db
            .select()
            .from(pendingInteractionTable)
            .where(eq(pendingInteractionTable.id, created.interaction.id))
            .get(),
        ).toMatchObject({ status: "pending", statusReason: null });
        expect(getThread(harness.deps.db, parent.id)?.status).toBe("active");
        for (const child of children) {
          expect(getThread(harness.deps.db, child.id)?.status).toBe("active");
        }

        // Reconnect the same daemon inside the 60s window and verify recovery.
        const resumedSession = seedSession(harness.deps, host.id);
        await handleHostSessionOpened(harness.deps, {
          activeThreads: [parent, ...children].map((t) => ({ threadId: t.id })),
          hostId: host.id,
          openedSession: resumedSession,
          previousSession: session,
        });
        harness.deps.hub.registerDaemon(
          resumedSession.id,
          host.id,
          createMockHubSocket(),
        );
        await vi.advanceTimersByTimeAsync(
          DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS,
        );
        expect(
          harness.db
            .select()
            .from(pendingInteractionTable)
            .where(eq(pendingInteractionTable.id, created.interaction.id))
            .get(),
        ).toMatchObject({ status: "pending", statusReason: null });

        // A second disconnect that exceeds the full active-work grace interrupts everything.
        handleDaemonSocketClosed(harness.deps, {
          sessionId: resumedSession.id,
        });
        await vi.advanceTimersByTimeAsync(
          DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS,
        );
        expect(
          harness.db
            .select()
            .from(pendingInteractionTable)
            .where(eq(pendingInteractionTable.id, created.interaction.id))
            .get(),
        ).toMatchObject({ status: "interrupted" });
        expect(getThread(harness.deps.db, parent.id)?.status).toBe("error");
        for (const child of children) {
          expect(getThread(harness.deps.db, child.id)?.status).toBe("error");
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it.each([
    ["same daemon reconnects", "instance-1", "resolved", 1],
    ["replacement daemon takes over", "instance-restarted", "interrupted", 0],
  ] as const)(
    "handles a resolution submitted during a brief disconnect when %s",
    async (_label, reconnectInstanceId, expectedStatus, expectedRpcCount) => {
      await withTestHarness(async (harness) => {
        vi.useFakeTimers();
        try {
          const { host, session } = seedHostSession(harness.deps, {
            id: `host-resolve-during-drop-${reconnectInstanceId}`,
          });
          const { project } = seedProjectWithSource(harness.deps, {
            hostId: host.id,
          });
          const environment = seedEnvironment(harness.deps, {
            hostId: host.id,
            projectId: project.id,
          });
          const parent = seedThread(harness.deps, {
            projectId: project.id,
            environmentId: environment.id,
            providerId: "claude-code",
            status: "active",
          });
          const created = registerPendingInteraction(
            harness.deps,
            harness.deps.pendingInteractions,
            {
              threadId: parent.id,
              turnId: "turn-resolve-during-drop",
              providerId: "claude-code",
              providerThreadId: "claude-resolve-during-drop",
              providerRequestId: `ask-resolve-during-drop-${reconnectInstanceId}`,
              payload: createUserQuestionPayload(),
            },
          );
          if (created.outcome === "rejected") {
            throw new Error(
              `Expected interaction registration to succeed: ${created.reason}`,
            );
          }
          harness.deps.hub.registerDaemon(
            session.id,
            host.id,
            createMockHubSocket(),
          );

          handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
          await vi.advanceTimersByTimeAsync(2_000);

          harness.deps.pendingInteractions.resolvePendingInteraction({
            threadId: parent.id,
            interactionId: created.interaction.id,
            resolution: createUserAnswerResolution(),
          });
          await vi.advanceTimersByTimeAsync(8_000);

          expect(
            harness.db
              .select()
              .from(pendingInteractionTable)
              .where(eq(pendingInteractionTable.id, created.interaction.id))
              .get(),
          ).toMatchObject({ status: "resolving" });

          const nextSession = openSession(harness.deps.db, {
            hostId: host.id,
            instanceId: reconnectInstanceId,
            hostName: host.name,
            dataDir: `/tmp/bb-host-data/${host.id}`,
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
            heartbeatIntervalMs: 5_000,
            leaseTimeoutMs: 30_000,
          });
          await handleHostSessionOpened(harness.deps, {
            activeThreads:
              reconnectInstanceId === "instance-1"
                ? [{ threadId: parent.id }]
                : [],
            hostId: host.id,
            openedSession: nextSession,
            previousSession: session,
          });

          const sentCommands: string[] = [];
          let threadSelectsBeforeSend = 0;
          let countThreadSelects = reconnectInstanceId === "instance-1";
          const client = harness.db.$client;
          const origPrepare = client.prepare.bind(client);
          client.prepare = ((sql: string) => {
            if (
              countThreadSelects &&
              /^\s*select\b/iu.test(sql) &&
              sql.includes('"threads"')
            ) {
              threadSelectsBeforeSend += 1;
            }
            return origPrepare(sql);
          }) as typeof client.prepare;
          const nextSocket = createMockHubSocket();
          const baseSend = nextSocket.send;
          nextSocket.send = (data: string) => {
            baseSend(data);
            const parsed = JSON.parse(data) as {
              type?: string;
              requestId?: string;
              command?: { type: string };
            };
            if (
              parsed.type === "host-rpc.request" &&
              parsed.requestId &&
              parsed.command
            ) {
              countThreadSelects = false;
              sentCommands.push(parsed.command.type);
              harness.deps.hub.recordHostOnlineRpcResponse({
                sessionId: nextSession.id,
                message: {
                  type: "host-rpc.response",
                  requestId: parsed.requestId,
                  commandType: parsed.command.type as "interactive.resolve",
                  ok: true,
                  result: {},
                },
              });
            }
          };
          try {
            harness.deps.hub.registerDaemon(
              nextSession.id,
              host.id,
              nextSocket,
            );
            await vi.advanceTimersByTimeAsync(0);
          } finally {
            client.prepare = origPrepare;
          }

          if (reconnectInstanceId === "instance-1") {
            expect(threadSelectsBeforeSend).toBe(1);
          }
          expect(
            harness.db
              .select()
              .from(pendingInteractionTable)
              .where(eq(pendingInteractionTable.id, created.interaction.id))
              .get()?.status,
          ).toBe(expectedStatus);
          expect(sentCommands).toHaveLength(expectedRpcCount);
        } finally {
          vi.useRealTimers();
        }
      });
    },
  );

  it.each([
    ["same daemon returns within original grace", true, "resolved", 2],
    ["original grace expires before second reconnect", false, "interrupted", 1],
  ] as const)(
    "preserves an accepted answer across a second brief disconnect before ack when %s",
    async (_label, reconnectInTime, expectedStatus, expectedRpcCount) => {
      await withTestHarness(async (harness) => {
        vi.useFakeTimers();
        try {
          const { host, session } = seedHostSession(harness.deps, {
            id: `host-second-drop-${String(reconnectInTime)}`,
          });
          const { project } = seedProjectWithSource(harness.deps, {
            hostId: host.id,
          });
          const environment = seedEnvironment(harness.deps, {
            hostId: host.id,
            projectId: project.id,
          });
          const thread = seedThread(harness.deps, {
            projectId: project.id,
            environmentId: environment.id,
            providerId: "claude-code",
            status: "active",
          });
          const created = registerPendingInteraction(
            harness.deps,
            harness.deps.pendingInteractions,
            {
              threadId: thread.id,
              turnId: `turn-second-drop-${String(reconnectInTime)}`,
              providerId: "claude-code",
              providerThreadId: `claude-second-drop-${String(reconnectInTime)}`,
              providerRequestId: `req-second-drop-${String(reconnectInTime)}`,
              payload: createCommandApprovalPayload({
                itemId: `item-second-drop-${String(reconnectInTime)}`,
                reason: "Run tests",
                command: "pnpm test",
                cwd: "/tmp/project",
              }),
            },
          );
          if (created.outcome === "rejected") {
            throw new Error(
              `Expected interaction registration to succeed: ${created.reason}`,
            );
          }
          harness.deps.hub.registerDaemon(
            session.id,
            host.id,
            createMockHubSocket(),
          );

          // First disconnect at t=0; user approves while offline at t=2s.
          handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
          await vi.advanceTimersByTimeAsync(2_000);
          harness.deps.pendingInteractions.resolvePendingInteraction({
            threadId: thread.id,
            interactionId: created.interaction.id,
            resolution: createAllowOnceResolution(),
          });
          await vi.advanceTimersByTimeAsync(8_000);

          // First reconnect at t=10s receives allow_once but drops at t=12s before ack.
          const sentInteractionIds: string[] = [];
          const secondSession = openSession(harness.deps.db, {
            hostId: host.id,
            instanceId: session.instanceId,
            hostName: host.name,
            dataDir: `/tmp/bb-host-data/${host.id}`,
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
            heartbeatIntervalMs: 5_000,
            leaseTimeoutMs: 30_000,
          });
          await handleHostSessionOpened(harness.deps, {
            activeThreads: [{ threadId: thread.id }],
            hostId: host.id,
            openedSession: secondSession,
            previousSession: session,
          });
          const unackedSocket = createMockHubSocket();
          const baseUnackedSend = unackedSocket.send;
          unackedSocket.send = (data: string) => {
            baseUnackedSend(data);
            const parsed = JSON.parse(data) as {
              type?: string;
              command?: { type: string; interactionId?: string };
            };
            if (
              parsed.type === "host-rpc.request" &&
              parsed.command?.type === "interactive.resolve" &&
              parsed.command.interactionId
            ) {
              sentInteractionIds.push(parsed.command.interactionId);
            }
          };
          harness.deps.hub.registerDaemon(
            secondSession.id,
            host.id,
            unackedSocket,
          );
          await vi.advanceTimersByTimeAsync(2_000);
          expect(sentInteractionIds).toEqual([created.interaction.id]);

          // Second disconnect at t=12s while awaiting ack.
          handleDaemonSocketClosed(harness.deps, {
            sessionId: secondSession.id,
          });
          await vi.advanceTimersByTimeAsync(0);
          expect(
            harness.db
              .select()
              .from(pendingInteractionTable)
              .where(eq(pendingInteractionTable.id, created.interaction.id))
              .get(),
          ).toMatchObject({ status: "resolving" });

          if (reconnectInTime) {
            await vi.advanceTimersByTimeAsync(8_000);
            const thirdSession = openSession(harness.deps.db, {
              hostId: host.id,
              instanceId: session.instanceId,
              hostName: host.name,
              dataDir: `/tmp/bb-host-data/${host.id}`,
              protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
              heartbeatIntervalMs: 5_000,
              leaseTimeoutMs: 30_000,
            });
            await handleHostSessionOpened(harness.deps, {
              activeThreads: [{ threadId: thread.id }],
              hostId: host.id,
              openedSession: thirdSession,
              previousSession: secondSession,
            });
            const finalSocket = createMockHubSocket();
            const baseFinalSend = finalSocket.send;
            finalSocket.send = (data: string) => {
              baseFinalSend(data);
              const parsed = JSON.parse(data) as {
                type?: string;
                requestId?: string;
                command?: { type: string; interactionId?: string };
              };
              if (
                parsed.type === "host-rpc.request" &&
                parsed.requestId &&
                parsed.command?.type === "interactive.resolve" &&
                parsed.command.interactionId
              ) {
                sentInteractionIds.push(parsed.command.interactionId);
                harness.deps.hub.recordHostOnlineRpcResponse({
                  sessionId: thirdSession.id,
                  message: {
                    type: "host-rpc.response",
                    requestId: parsed.requestId,
                    commandType: "interactive.resolve",
                    ok: true,
                    result: {},
                  },
                });
              }
            };
            harness.deps.hub.registerDaemon(
              thirdSession.id,
              host.id,
              finalSocket,
            );
            await vi.advanceTimersByTimeAsync(0);
          } else {
            // Advance to original t=60s grace deadline (before secondSession's t=72s deadline).
            await vi.advanceTimersByTimeAsync(
              DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS - 12_000,
            );
          }

          expect(sentInteractionIds).toHaveLength(expectedRpcCount);
          expect(
            harness.db
              .select()
              .from(pendingInteractionTable)
              .where(eq(pendingInteractionTable.id, created.interaction.id))
              .get()?.status,
          ).toBe(expectedStatus);
        } finally {
          vi.useRealTimers();
        }
      });
    },
  );

  it("does not send a queued approval after the 60s grace deadline while waiting for a silent reconnected socket", async () => {
    await withTestHarness(async (harness) => {
      vi.useFakeTimers();
      try {
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-grace-deadline-silent-reconnect",
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
        });
        const thread = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          providerId: "claude-code",
          status: "active",
        });
        const created = registerPendingInteraction(
          harness.deps,
          harness.deps.pendingInteractions,
          {
            threadId: thread.id,
            turnId: "turn-grace-silent-reconnect",
            providerId: "claude-code",
            providerThreadId: "claude-grace-silent-reconnect",
            providerRequestId: "req-grace-silent-reconnect",
            payload: createCommandApprovalPayload({
              itemId: "item-grace-silent-reconnect",
              reason: "Run deploy",
              command: "npm run deploy",
              cwd: "/tmp/project",
            }),
          },
        );
        if (created.outcome === "rejected") {
          throw new Error(
            `Expected interaction registration to succeed: ${created.reason}`,
          );
        }
        harness.deps.hub.registerDaemon(
          session.id,
          host.id,
          createMockHubSocket(),
        );

        // Disconnect at t=0; answer while offline at t=2s.
        handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
        await vi.advanceTimersByTimeAsync(2_000);
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createAllowOnceResolution(),
        });

        // Reconnect at t=59.5s with an expired lease so online-rpc waits in waitForAnsweringDaemon.
        await vi.advanceTimersByTimeAsync(
          DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS - 2_500,
        );
        const reconnectedSession = openSession(harness.deps.db, {
          hostId: host.id,
          instanceId: session.instanceId,
          hostName: host.name,
          dataDir: `/tmp/bb-host-data/${host.id}`,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          heartbeatIntervalMs: 5_000,
          leaseTimeoutMs: 30_000,
        });
        await handleHostSessionOpened(harness.deps, {
          activeThreads: [{ threadId: thread.id }],
          hostId: host.id,
          openedSession: reconnectedSession,
          previousSession: session,
        });
        harness.db
          .update(hostDaemonSessions)
          .set({ leaseExpiresAt: Date.now() - 1_000 })
          .where(eq(hostDaemonSessions.id, reconnectedSession.id))
          .run();

        const sentCommands: string[] = [];
        const reconnectedSocket = createMockHubSocket();
        const baseSend = reconnectedSocket.send;
        reconnectedSocket.send = (data: string) => {
          baseSend(data);
          const parsed = JSON.parse(data) as {
            type?: string;
            command?: { type: string };
          };
          if (parsed.type === "host-rpc.request" && parsed.command) {
            sentCommands.push(parsed.command.type);
          }
        };
        harness.deps.hub.registerDaemon(
          reconnectedSession.id,
          host.id,
          reconnectedSocket,
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(sentCommands).toEqual([]);

        // Cross the 60s grace deadline at t=60s before any heartbeat arrives.
        await vi.advanceTimersByTimeAsync(500);
        expect(
          harness.db
            .select()
            .from(pendingInteractionTable)
            .where(eq(pendingInteractionTable.id, created.interaction.id))
            .get()?.status,
        ).toBe("interrupted");

        // Heartbeat arrives at t=61.25s; interactive.resolve must never be written to the socket.
        await vi.advanceTimersByTimeAsync(1_250);
        harness.db
          .update(hostDaemonSessions)
          .set({ leaseExpiresAt: Date.now() + 30_000 })
          .where(eq(hostDaemonSessions.id, reconnectedSession.id))
          .run();
        await vi.advanceTimersByTimeAsync(500);

        expect(sentCommands).toEqual([]);
        expect(
          harness.db
            .select()
            .from(pendingInteractionTable)
            .where(eq(pendingInteractionTable.id, created.interaction.id))
            .get()?.status,
        ).toBe("interrupted");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it.each(["stop", "archive", "archive-then-unarchive"] as const)(
    "cancels a queued approval and never delivers it on reconnect after %s during disconnect",
    async (action) => {
      await withTestHarness(async (harness) => {
        vi.useFakeTimers();
        try {
          const { host, session } = seedHostSession(harness.deps, {
            id: `host-resolve-cancelled-${action}`,
          });
          const { project } = seedProjectWithSource(harness.deps, {
            hostId: host.id,
          });
          const environment = seedEnvironment(harness.deps, {
            hostId: host.id,
            projectId: project.id,
          });
          const thread = seedThread(harness.deps, {
            projectId: project.id,
            environmentId: environment.id,
            providerId: "claude-code",
            status: "active",
          });
          const created = registerPendingInteraction(
            harness.deps,
            harness.deps.pendingInteractions,
            {
              threadId: thread.id,
              turnId: `turn-cancel-${action}`,
              providerId: "claude-code",
              providerThreadId: `claude-cancel-${action}`,
              providerRequestId: `req-cancel-${action}`,
              payload: createCommandApprovalPayload({
                itemId: `item-cancel-${action}`,
                reason: "Run deploy",
                command: "npm run deploy",
                cwd: "/tmp/project",
              }),
            },
          );
          if (created.outcome === "rejected") {
            throw new Error(
              `Expected interaction registration to succeed: ${created.reason}`,
            );
          }
          harness.deps.hub.registerDaemon(
            session.id,
            host.id,
            createMockHubSocket(),
          );

          handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
          await vi.advanceTimersByTimeAsync(1_000);

          harness.deps.pendingInteractions.resolvePendingInteraction({
            threadId: thread.id,
            interactionId: created.interaction.id,
            resolution: createAllowOnceResolution(),
          });
          await vi.advanceTimersByTimeAsync(0);

          if (action === "stop") {
            requestThreadStopForCurrentState(harness.deps, thread, environment);
          } else {
            archiveThreadAndReleaseChildren(harness.deps, {
              threadId: thread.id,
            });
            if (action === "archive-then-unarchive") {
              unarchiveThreadKeepingOpenParent(harness.deps, thread.id);
            }
          }
          await vi.advanceTimersByTimeAsync(5_000);

          const nextSession = openSession(harness.deps.db, {
            hostId: host.id,
            instanceId: session.instanceId,
            hostName: host.name,
            dataDir: `/tmp/bb-host-data/${host.id}`,
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
            heartbeatIntervalMs: 5_000,
            leaseTimeoutMs: 30_000,
          });
          await handleHostSessionOpened(harness.deps, {
            activeThreads: [{ threadId: thread.id }],
            hostId: host.id,
            openedSession: nextSession,
            previousSession: session,
          });

          const sentCommands: string[] = [];
          const nextSocket = createMockHubSocket();
          const baseSend = nextSocket.send;
          nextSocket.send = (data: string) => {
            baseSend(data);
            const parsed = JSON.parse(data) as {
              type?: string;
              requestId?: string;
              command?: { type: string };
            };
            if (
              parsed.type === "host-rpc.request" &&
              parsed.requestId &&
              parsed.command
            ) {
              sentCommands.push(parsed.command.type);
              harness.deps.hub.recordHostOnlineRpcResponse({
                sessionId: nextSession.id,
                message: {
                  type: "host-rpc.response",
                  requestId: parsed.requestId,
                  commandType: parsed.command.type as "interactive.resolve",
                  ok: true,
                  result: {},
                },
              });
            }
          };
          harness.deps.hub.registerDaemon(nextSession.id, host.id, nextSocket);
          await vi.advanceTimersByTimeAsync(0);

          expect(
            sentCommands.filter((type) => type === "interactive.resolve"),
          ).toHaveLength(0);
          expect(
            harness.db
              .select()
              .from(pendingInteractionTable)
              .where(eq(pendingInteractionTable.id, created.interaction.id))
              .get()?.status,
          ).toBe("interrupted");
        } finally {
          vi.useRealTimers();
        }
      });
    },
  );

  it("cancels a queued approval waiting on a silent host socket so stop never sends it before thread.stop", async () => {
    await withTestHarness(async (harness) => {
      vi.useFakeTimers();
      try {
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-resolve-cancelled-silent-socket",
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
        });
        const thread = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          providerId: "claude-code",
          status: "active",
        });
        const created = registerPendingInteraction(
          harness.deps,
          harness.deps.pendingInteractions,
          {
            threadId: thread.id,
            turnId: "turn-silent-cancel",
            providerId: "claude-code",
            providerThreadId: "claude-silent-cancel",
            providerRequestId: "req-silent-cancel",
            payload: createCommandApprovalPayload({
              itemId: "item-silent-cancel",
              reason: "Run deploy",
              command: "npm run deploy",
              cwd: "/tmp/project",
            }),
          },
        );
        if (created.outcome === "rejected") {
          throw new Error(
            `Expected interaction registration to succeed: ${created.reason}`,
          );
        }

        const sentCommands: string[] = [];
        const socket = createMockHubSocket();
        const baseSend = socket.send;
        socket.send = (data: string) => {
          baseSend(data);
          const parsed = JSON.parse(data) as {
            type?: string;
            requestId?: string;
            command?: { type: string };
          };
          if (
            parsed.type === "host-rpc.request" &&
            parsed.requestId &&
            parsed.command
          ) {
            sentCommands.push(parsed.command.type);
            harness.deps.hub.recordHostOnlineRpcResponse({
              sessionId: session.id,
              message: {
                type: "host-rpc.response",
                requestId: parsed.requestId,
                commandType: parsed.command.type as "thread.stop",
                ok: true,
                result: { providerCheckpointId: null },
              },
            });
          }
        };
        harness.deps.hub.registerDaemon(session.id, host.id, socket);

        // Expire the daemon lease without closing the socket so online-rpc queues behind waitForAnsweringDaemon.
        harness.db
          .update(hostDaemonSessions)
          .set({ leaseExpiresAt: Date.now() - 1_000 })
          .where(eq(hostDaemonSessions.id, session.id))
          .run();

        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createAllowOnceResolution(),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(sentCommands).toEqual([]);

        requestThreadStopForCurrentState(harness.deps, thread, environment);
        await vi.advanceTimersByTimeAsync(0);

        // Host answers again; only thread.stop may be sent, never the cancelled interactive.resolve.
        harness.db
          .update(hostDaemonSessions)
          .set({ leaseExpiresAt: Date.now() + 30_000 })
          .where(eq(hostDaemonSessions.id, session.id))
          .run();
        await vi.advanceTimersByTimeAsync(500);

        expect(sentCommands).toEqual(["thread.stop"]);
        expect(
          harness.db
            .select()
            .from(pendingInteractionTable)
            .where(eq(pendingInteractionTable.id, created.interaction.id))
            .get()?.status,
        ).toBe("interrupted");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("preserves an already-sent approval reply when stop arrives before the daemon responds", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-stop-after-wire-send",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "claude-code",
        status: "active",
      });
      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-stop-after-send",
          providerId: "claude-code",
          providerThreadId: "claude-stop-after-send",
          providerRequestId: "req-stop-after-send",
          payload: createCommandApprovalPayload({
            itemId: "item-stop-after-send",
            reason: "Run deploy",
            command: "npm run deploy",
            cwd: "/tmp/project",
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      let resolveRequestId: string | null = null;
      let stopRequestId: string | null = null;
      const socket = createMockHubSocket();
      const baseSend = socket.send;
      socket.send = (data: string) => {
        baseSend(data);
        const parsed = JSON.parse(data) as {
          type?: string;
          requestId?: string;
          command?: { type: string };
        };
        if (parsed.type === "host-rpc.request" && parsed.requestId) {
          if (parsed.command?.type === "interactive.resolve") {
            resolveRequestId = parsed.requestId;
          } else if (parsed.command?.type === "thread.stop") {
            stopRequestId = parsed.requestId;
          }
        }
      };
      harness.deps.hub.registerDaemon(session.id, host.id, socket);

      const resolution = createAllowOnceResolution();
      harness.deps.pendingInteractions.resolvePendingInteraction({
        threadId: thread.id,
        interactionId: created.interaction.id,
        resolution,
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(resolveRequestId).not.toBeNull();

      // Stop arrives after interactive.resolve is already on the wire, before its reply.
      requestThreadStopForCurrentState(harness.deps, thread, environment);
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopRequestId).not.toBeNull();

      const disposition = harness.deps.hub.recordHostOnlineRpcResponse({
        sessionId: session.id,
        message: {
          type: "host-rpc.response",
          requestId: resolveRequestId!,
          commandType: "interactive.resolve",
          ok: true,
          result: {},
        },
      });
      expect(disposition).toEqual({ handled: true });
      await new Promise((resolve) => setImmediate(resolve));

      harness.deps.hub.recordHostOnlineRpcResponse({
        sessionId: session.id,
        message: {
          type: "host-rpc.response",
          requestId: stopRequestId!,
          commandType: "thread.stop",
          ok: true,
          result: { providerCheckpointId: null },
        },
      });
      await new Promise((resolve) => setImmediate(resolve));

      const settled = harness.db
        .select()
        .from(pendingInteractionTable)
        .where(eq(pendingInteractionTable.id, created.interaction.id))
        .get();
      expect(settled?.status).toBe("resolved");
      expect(settled?.resolution).toBe(JSON.stringify(resolution));
    });
  });

  it.each([
    ["same daemon reconnects", true, "resolved", 1, 0],
    ["daemon never returns before grace expires", false, "interrupted", 0, 0],
    [
      "server returns after the answer's deadline",
      true,
      "interrupted",
      0,
      2 * 60 * 60 * 1000,
    ],
  ] as const)(
    "recovers a persisted resolving interaction after a server restart when %s",
    async (
      _label,
      shouldReconnect,
      expectedStatus,
      expectedRpcCount,
      downMs,
    ) => {
      await withTestHarness(async (harness) => {
        vi.useFakeTimers();
        try {
          const { host, session } = seedHostSession(harness.deps, {
            id: `host-restart-resolving-${String(shouldReconnect)}`,
          });
          const { project } = seedProjectWithSource(harness.deps, {
            hostId: host.id,
          });
          const environment = seedEnvironment(harness.deps, {
            hostId: host.id,
            projectId: project.id,
          });
          const thread = seedThread(harness.deps, {
            projectId: project.id,
            environmentId: environment.id,
            providerId: "claude-code",
            status: "active",
          });
          const created = registerPendingInteraction(
            harness.deps,
            harness.deps.pendingInteractions,
            {
              threadId: thread.id,
              turnId: `turn-restart-resolving-${String(shouldReconnect)}`,
              providerId: "claude-code",
              providerThreadId: `claude-restart-${String(shouldReconnect)}`,
              providerRequestId: `req-restart-${String(shouldReconnect)}`,
              payload: createUserQuestionPayload(),
            },
          );
          if (created.outcome === "rejected") {
            throw new Error(
              `Expected interaction registration to succeed: ${created.reason}`,
            );
          }
          harness.deps.hub.registerDaemon(
            session.id,
            host.id,
            createMockHubSocket(),
          );

          handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
          await vi.advanceTimersByTimeAsync(1_000);
          harness.deps.pendingInteractions.resolvePendingInteraction({
            threadId: thread.id,
            interactionId: created.interaction.id,
            resolution: createUserAnswerResolution(),
          });
          await vi.advanceTimersByTimeAsync(0);
          expect(
            harness.db
              .select()
              .from(pendingInteractionTable)
              .where(eq(pendingInteractionTable.id, created.interaction.id))
              .get()?.status,
          ).toBe("resolving");

          // Simulate a server restart with a fresh Hub and PendingInteractionLifecycle.
          vi.setSystemTime(Date.now() + downMs);
          const restartedHub = new NotificationHub();
          const restartedPending = new PendingInteractionLifecycle({
            ...harness.deps,
            hub: restartedHub,
          });
          restartedPending.start();
          const restartedDeps = {
            ...harness.deps,
            hub: restartedHub,
            pendingInteractions: restartedPending,
          };
          startRunningTurnDeadlinesAfterRestart(restartedDeps);

          const sentCommands: string[] = [];
          if (shouldReconnect) {
            await vi.advanceTimersByTimeAsync(3_000);
            const nextSession = openSession(harness.deps.db, {
              hostId: host.id,
              instanceId: session.instanceId,
              hostName: host.name,
              dataDir: `/tmp/bb-host-data/${host.id}`,
              protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
              heartbeatIntervalMs: 5_000,
              leaseTimeoutMs: 30_000,
            });
            await handleHostSessionOpened(restartedDeps, {
              activeThreads: [{ threadId: thread.id }],
              hostId: host.id,
              openedSession: nextSession,
              previousSession: session,
            });
            const nextSocket = createMockHubSocket();
            const baseSend = nextSocket.send;
            nextSocket.send = (data: string) => {
              baseSend(data);
              const parsed = JSON.parse(data) as {
                type?: string;
                requestId?: string;
                command?: { type: string };
              };
              if (
                parsed.type === "host-rpc.request" &&
                parsed.requestId &&
                parsed.command
              ) {
                sentCommands.push(parsed.command.type);
                restartedHub.recordHostOnlineRpcResponse({
                  sessionId: nextSession.id,
                  message: {
                    type: "host-rpc.response",
                    requestId: parsed.requestId,
                    commandType: parsed.command.type as "interactive.resolve",
                    ok: true,
                    result: {},
                  },
                });
              }
            };
            restartedHub.registerDaemon(nextSession.id, host.id, nextSocket);
            await vi.advanceTimersByTimeAsync(0);
          } else {
            await vi.advanceTimersByTimeAsync(
              DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS,
            );
          }

          expect(
            harness.db
              .select()
              .from(pendingInteractionTable)
              .where(eq(pendingInteractionTable.id, created.interaction.id))
              .get()?.status,
          ).toBe(expectedStatus);
          expect(sentCommands).toHaveLength(expectedRpcCount);
        } finally {
          vi.useRealTimers();
        }
      });
    },
  );

  it("resumes resolving interactions in one JOIN query and survives corrupt payload rows on restart", async () => {
    await withTestHarness(async (harness) => {
      vi.useFakeTimers();
      try {
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-restart-single-join-corrupt",
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
        });
        const threads = [1, 2, 3].map((index) =>
          seedThread(harness.deps, {
            projectId: project.id,
            environmentId: environment.id,
            providerId: "claude-code",
            status: "active",
            title: `Restart recovery ${index}`,
          }),
        );
        const interactions = threads.map((thread, index) => {
          const created = registerPendingInteraction(
            harness.deps,
            harness.deps.pendingInteractions,
            {
              threadId: thread.id,
              turnId: `turn-restart-join-${index}`,
              providerId: "claude-code",
              providerThreadId: `claude-restart-join-${index}`,
              providerRequestId: `req-restart-join-${index}`,
              payload: createUserQuestionPayload(),
            },
          );
          if (created.outcome === "rejected") {
            throw new Error(
              `Expected interaction registration to succeed: ${created.reason}`,
            );
          }
          harness.db
            .update(pendingInteractionTable)
            .set({
              status: "resolving",
              resolution: JSON.stringify(createUserAnswerResolution()),
              ...(index === 0 ? { payload: "{" } : {}),
            })
            .where(eq(pendingInteractionTable.id, created.interaction.id))
            .run();
          return created.interaction;
        });

        const restartedHub = new NotificationHub();
        const restartedPending = new PendingInteractionLifecycle({
          ...harness.deps,
          hub: restartedHub,
        });
        restartedPending.start();
        const restartedDeps = {
          ...harness.deps,
          hub: restartedHub,
          pendingInteractions: restartedPending,
        };

        let selectCount = 0;
        const client = harness.db.$client;
        const origPrepare = client.prepare.bind(client);
        client.prepare = ((sql: string) => {
          if (/^\s*select\b/iu.test(sql)) {
            selectCount += 1;
          }
          return origPrepare(sql);
        }) as typeof client.prepare;

        try {
          expect(() =>
            restartedPending.resumeResolvingInteractionsAfterRestart(),
          ).not.toThrow();
        } finally {
          client.prepare = origPrepare;
        }

        expect(selectCount).toBe(1);
        expect(
          harness.db
            .select()
            .from(pendingInteractionTable)
            .where(eq(pendingInteractionTable.id, interactions[0]!.id))
            .get()?.status,
        ).toBe("interrupted");

        const nextSession = openSession(harness.deps.db, {
          hostId: host.id,
          instanceId: session.instanceId,
          hostName: host.name,
          dataDir: `/tmp/bb-host-data/${host.id}`,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          heartbeatIntervalMs: 5_000,
          leaseTimeoutMs: 30_000,
        });
        await handleHostSessionOpened(restartedDeps, {
          activeThreads: threads.slice(1).map((thread) => ({
            threadId: thread.id,
          })),
          hostId: host.id,
          openedSession: nextSession,
          previousSession: session,
        });
        const resolvedIds: string[] = [];
        const nextSocket = createMockHubSocket();
        const baseSend = nextSocket.send;
        nextSocket.send = (data: string) => {
          baseSend(data);
          const parsed = JSON.parse(data) as {
            type?: string;
            requestId?: string;
            command?: { type: string; interactionId?: string };
          };
          if (
            parsed.type === "host-rpc.request" &&
            parsed.requestId &&
            parsed.command?.type === "interactive.resolve" &&
            parsed.command.interactionId
          ) {
            resolvedIds.push(parsed.command.interactionId);
            restartedHub.recordHostOnlineRpcResponse({
              sessionId: nextSession.id,
              message: {
                type: "host-rpc.response",
                requestId: parsed.requestId,
                commandType: "interactive.resolve",
                ok: true,
                result: {},
              },
            });
          }
        };
        restartedHub.registerDaemon(nextSession.id, host.id, nextSocket);
        await vi.advanceTimersByTimeAsync(0);

        expect(resolvedIds).toEqual([interactions[1]!.id, interactions[2]!.id]);
        for (const interaction of interactions.slice(1)) {
          expect(
            harness.db
              .select()
              .from(pendingInteractionTable)
              .where(eq(pendingInteractionTable.id, interaction.id))
              .get()?.status,
          ).toBe("resolved");
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("avoids a redundant pending_interactions SELECT on the connected resolve path", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-connected-resolve-single-select",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "claude-code",
        status: "active",
      });
      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-connected-single-select",
          providerId: "claude-code",
          providerThreadId: "claude-connected-single-select",
          providerRequestId: "req-connected-single-select",
          payload: createUserQuestionPayload(),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }
      const socket = createMockHubSocket();
      const baseSend = socket.send;
      socket.send = (data: string) => {
        baseSend(data);
        const parsed = JSON.parse(data) as {
          type?: string;
          requestId?: string;
          command?: { type: string };
        };
        if (
          parsed.type === "host-rpc.request" &&
          parsed.requestId &&
          parsed.command
        ) {
          harness.deps.hub.recordHostOnlineRpcResponse({
            sessionId: session.id,
            message: {
              type: "host-rpc.response",
              requestId: parsed.requestId,
              commandType: parsed.command.type as "interactive.resolve",
              ok: true,
              result: {},
            },
          });
        }
      };
      harness.deps.hub.registerDaemon(session.id, host.id, socket);

      let selectsById = 0;
      const client = harness.db.$client;
      const origPrepare = client.prepare.bind(client);
      client.prepare = ((sql: string) => {
        if (
          /^\s*select\b/iu.test(sql) &&
          sql.includes('"pending_interactions"') &&
          sql.includes('"pending_interactions"."id" = ?')
        ) {
          selectsById += 1;
        }
        return origPrepare(sql);
      }) as typeof client.prepare;

      try {
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createUserAnswerResolution(),
        });
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        client.prepare = origPrepare;
      }

      expect(selectsById).toBe(1);
      expect(
        harness.db
          .select()
          .from(pendingInteractionTable)
          .where(eq(pendingInteractionTable.id, created.interaction.id))
          .get()?.status,
      ).toBe("resolved");
    });
  });

  it("adds zero pending_interactions writes on ordinary archive/delete and zero thread reads on connected status-changed", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-no-extra-queries",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const ordinaryThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "claude-code",
        status: "idle",
      });
      const activeThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "claude-code",
        status: "active",
      });
      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: activeThread.id,
          turnId: "turn-connected-status-no-select",
          providerId: "claude-code",
          providerThreadId: "claude-connected-status-no-select",
          providerRequestId: "req-connected-status-no-select",
          payload: createUserQuestionPayload(),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      let pendingRequestId: string | null = null;
      const socket = createMockHubSocket();
      const baseSend = socket.send;
      socket.send = (data: string) => {
        baseSend(data);
        const parsed = JSON.parse(data) as {
          type?: string;
          requestId?: string;
        };
        if (parsed.type === "host-rpc.request" && parsed.requestId) {
          pendingRequestId = parsed.requestId;
        }
      };
      harness.deps.hub.registerDaemon(session.id, host.id, socket);

      const client = harness.db.$client;
      const origPrepare = client.prepare.bind(client);
      let pendingInteractionWrites = 0;
      let threadSelects = 0;
      client.prepare = ((sql: string) => {
        if (
          /^\s*(?:insert|update|delete)\b/iu.test(sql) &&
          sql.includes('"pending_interactions"')
        ) {
          pendingInteractionWrites += 1;
        }
        if (/^\s*select\b/iu.test(sql) && sql.includes('"threads"')) {
          threadSelects += 1;
        }
        return origPrepare(sql);
      }) as typeof client.prepare;

      try {
        archiveThreadAndReleaseChildren(harness.deps, {
          threadId: ordinaryThread.id,
        });
        markThreadDeleted(harness.db, harness.hub, {
          threadId: ordinaryThread.id,
        });
        expect(pendingInteractionWrites).toBe(0);

        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: activeThread.id,
          interactionId: created.interaction.id,
          resolution: createUserAnswerResolution(),
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(pendingRequestId).not.toBeNull();

        let observedStatusChanges = 0;
        const stopObserving = harness.hub.onChangedMessage((message) => {
          if (
            message.entity === "thread" &&
            message.id === activeThread.id &&
            message.changes.includes("status-changed")
          ) {
            observedStatusChanges += 1;
          }
        });
        threadSelects = 0;
        try {
          harness.hub.notifyThread(activeThread.id, ["status-changed"]);
          harness.hub.notifyThread(activeThread.id, ["status-changed"], {
            statusChange: {
              status: "active",
              runtime: {
                displayStatus: "active",
                hostReconnectGraceExpiresAt: null,
              },
              activity: {
                activeWorkflowCount: 0,
                activeBackgroundAgentCount: 0,
                activeBackgroundCommandCount: 0,
                activePlanModeCount: 0,
                activeGoalCount: 0,
              },
              latestAttentionAt: Date.now(),
              updatedAt: Date.now(),
            },
          });
        } finally {
          stopObserving();
        }
        expect(observedStatusChanges).toBe(2);
        expect(threadSelects).toBe(0);

        harness.hub.recordHostOnlineRpcResponse({
          sessionId: session.id,
          message: {
            type: "host-rpc.response",
            requestId: pendingRequestId!,
            commandType: "interactive.resolve",
            ok: true,
            result: {},
          },
        });
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        client.prepare = origPrepare;
      }

      expect(
        harness.db
          .select()
          .from(pendingInteractionTable)
          .where(eq(pendingInteractionTable.id, created.interaction.id))
          .get()?.status,
      ).toBe("resolved");
    });
  });

  it("rejects active provider request reuse with a different payload", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-reconnect-payload-mismatch",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const baseInteraction: PendingInteractionCreate = {
        threadId: thread.id,
        turnId: "turn-reconnect-payload-mismatch",
        providerId: "codex",
        providerThreadId: "provider-thread-reconnect-payload-mismatch",
        providerRequestId: "request-reconnect-payload-mismatch",
        payload: createCommandApprovalPayload({
          itemId: "item-reconnect-payload-mismatch",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
        }),
      };

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        baseInteraction,
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      expect(
        registerPendingInteraction(
          harness.deps,
          harness.deps.pendingInteractions,
          {
            ...baseInteraction,
            payload: createCommandApprovalPayload({
              itemId: "item-reconnect-payload-mismatch",
              reason: "Different approval",
              command: "git push",
              cwd: "/tmp/project",
            }),
          },
        ),
      ).toEqual({
        outcome: "rejected",
        reason:
          "Provider request request-reconnect-payload-mismatch is already awaiting a different interaction payload",
      });
    });
  });

  it("rejects interactions from providers that do not own the thread", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-provider-mismatch",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
      });

      expect(
        registerPendingInteraction(
          harness.deps,
          harness.deps.pendingInteractions,
          {
            threadId: thread.id,
            turnId: "turn-provider-mismatch",
            providerId: "claude-code",
            providerThreadId: "provider-thread-provider-mismatch",
            providerRequestId: "request-provider-mismatch",
            payload: createCommandApprovalPayload({
              itemId: "item-provider-mismatch",
              reason: "Needs approval",
              command: "git push",
              cwd: "/tmp/project",
              availableDecisions: ["allow_once", "deny"],
            }),
          },
        ),
      ).toEqual({
        outcome: "rejected",
        reason: `Thread ${thread.id} belongs to provider codex, not claude-code`,
      });
    });
  });

  it("treats reordered permission grants as idempotent resolution retries", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-idempotent-permissions",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-idempotent-permissions",
          providerId: "codex",
          providerThreadId: "provider-thread-idempotent-permissions",
          providerRequestId: "request-idempotent-permissions",
          payload: createPermissionGrantApprovalPayload({
            itemId: "item-idempotent-permissions",
            reason: "Needs workspace access",
            toolName: "Bash",
            permissions: {
              network: null,
              fileSystem: {
                read: ["/tmp/project/a", "/tmp/project/b"],
                write: ["/tmp/project/c", "/tmp/project/d"],
              },
            },
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      const firstResolution =
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createAllowOnceResolution({
            network: null,
            fileSystem: {
              read: ["/tmp/project/a", "/tmp/project/b"],
              write: ["/tmp/project/c", "/tmp/project/d"],
            },
          }),
        });
      expect(firstResolution.status).toBe("resolving");

      const retryResolution =
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createAllowOnceResolution({
            network: null,
            fileSystem: {
              read: ["/tmp/project/b", "/tmp/project/a"],
              write: ["/tmp/project/d", "/tmp/project/c"],
            },
          }),
        });

      expect(retryResolution).toMatchObject({
        id: created.interaction.id,
        status: "resolving",
        resolution: firstResolution.resolution,
      });
      const resolvingRow = harness.db
        .select()
        .from(pendingInteractionTable)
        .where(eq(pendingInteractionTable.id, created.interaction.id))
        .get();
      expect(resolvingRow).toMatchObject({
        status: "resolving",
        resolution: JSON.stringify(firstResolution.resolution),
      });

      const completed = harness.db.transaction((tx) =>
        harness.deps.pendingInteractions.completeResolvingInteractionInTransaction(
          { db: tx, hub: harness.deps.hub },
          {
            interactionId: created.interaction.id,
            resolution: createAllowOnceResolution({
              network: null,
              fileSystem: {
                read: ["/tmp/project/a", "/tmp/project/b"],
                write: ["/tmp/project/c", "/tmp/project/d"],
              },
            }),
          },
        ),
      );
      expect(completed?.status).toBe("resolved");
      const resolvedRow = harness.db
        .select()
        .from(pendingInteractionTable)
        .where(eq(pendingInteractionTable.id, created.interaction.id))
        .get();
      expect(resolvedRow).toMatchObject({
        status: "resolved",
      });
    });
  });

  it("rejects permission allow resolutions that grant nothing", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-empty-grant",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-empty-grant",
          providerId: "codex",
          providerThreadId: "provider-thread-empty-grant",
          providerRequestId: "request-empty-grant",
          payload: createPermissionGrantApprovalPayload({
            itemId: "item-empty-grant",
            reason: "Needs network access",
            toolName: "WebFetch",
            permissions: {
              network: { enabled: true },
              fileSystem: null,
            },
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      expect(() =>
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createAllowForSessionResolution({
            network: null,
            fileSystem: null,
          }),
        }),
      ).toThrow(
        "Allowed permission resolutions must grant at least one permission",
      );

      expect(
        harness.deps.pendingInteractions.getThreadInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
        }).status,
      ).toBe("pending");
    });
  });

  it("allows a permission grant whose request has nothing to grant", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-no-grantable",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-no-grantable",
          providerId: "codex",
          providerThreadId: "provider-thread-no-grantable",
          providerRequestId: "request-no-grantable",
          payload: createPermissionGrantApprovalPayload({
            itemId: "item-no-grantable",
            reason: "Needs approval",
            toolName: "SomeOpaqueTool",
            permissions: {
              network: null,
              fileSystem: null,
            },
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      harness.deps.pendingInteractions.resolvePendingInteraction({
        threadId: thread.id,
        interactionId: created.interaction.id,
        resolution: createAllowOnceResolution({
          network: null,
          fileSystem: null,
        }),
      });

      expect(
        harness.deps.pendingInteractions.getThreadInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
        }).status,
      ).not.toBe("pending");
    });
  });

  it("accepts tool-use approvals without a timeline item of their own", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-tool-use",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-tool-use",
          providerId: "codex",
          providerThreadId: "provider-thread-tool-use",
          providerRequestId: "request-tool-use",
          payload: createToolUseApprovalPayload({ itemId: "mcp-call-1" }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }
      const itemEventsFor = () =>
        harness.db
          .select()
          .from(eventTable)
          .where(eq(eventTable.threadId, thread.id))
          .all()
          .filter((row) => row.type.startsWith("item/"));
      expect(itemEventsFor()).toEqual([]);

      expect(
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createDenyResolution(),
        }),
      ).toEqual(
        expect.objectContaining({
          status: "resolving",
          resolution: expect.objectContaining({ decision: "deny" }),
        }),
      );
      expect(itemEventsFor()).toEqual([]);
    });
  });

  it("appends one interaction lifecycle event per status change, paired with the resolution, for every kind", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-lifecycle-event",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const lifecycleEvents = () =>
        harness.db
          .select()
          .from(eventTable)
          .where(eq(eventTable.threadId, thread.id))
          .all()
          .filter((row) => row.type === "system/interaction/lifecycle")
          .map((row) => ({
            scope:
              row.scopeKind === "turn"
                ? { kind: "turn", turnId: row.turnId }
                : { kind: "thread" },
            interaction: JSON.parse(row.data).interaction,
          }));

      const grant = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-lifecycle",
          providerId: "codex",
          providerThreadId: "provider-thread-lifecycle",
          providerRequestId: "request-lifecycle-grant",
          payload: createPermissionGrantApprovalPayload({
            itemId: "item-grant",
          }),
        },
      );
      if (grant.outcome === "rejected") {
        throw new Error(`Expected registration to succeed: ${grant.reason}`);
      }
      const resolution = createAllowForSessionResolution({
        network: null,
        fileSystem: null,
      });
      harness.deps.pendingInteractions.resolvePendingInteraction({
        threadId: thread.id,
        interactionId: grant.interaction.id,
        resolution,
      });
      harness.db.transaction((tx) =>
        harness.deps.pendingInteractions.completeResolvingInteractionInTransaction(
          { db: tx, hub: harness.deps.hub },
          {
            interactionId: grant.interaction.id,
            resolution,
          },
        ),
      );

      expect(lifecycleEvents()).toEqual([
        {
          scope: { kind: "turn", turnId: "turn-lifecycle" },
          interaction: expect.objectContaining({
            id: grant.interaction.id,
            status: "pending",
            statusReason: null,
            origin: {
              kind: "provider",
              providerId: "codex",
              providerRequestId: "request-lifecycle-grant",
            },
            payload: {
              kind: "approval",
              reason: "Grant permission",
              subject: expect.objectContaining({
                kind: "permission_grant",
                itemId: "item-grant",
              }),
            },
            resolution: null,
          }),
        },
        {
          scope: { kind: "turn", turnId: "turn-lifecycle" },
          interaction: expect.objectContaining({
            id: grant.interaction.id,
            status: "resolving",
            resolution,
          }),
        },
        {
          scope: { kind: "turn", turnId: "turn-lifecycle" },
          interaction: expect.objectContaining({
            id: grant.interaction.id,
            status: "resolved",
            resolution,
          }),
        },
      ]);
      expect(lifecycleEvents()[0]?.interaction.payload).not.toHaveProperty(
        "availableDecisions",
      );

      const pending = requestPluginInteraction(harness.deps, {
        threadId: thread.id,
        name: "SENTINEL_FIELD",
      });
      const [pluginInteraction] =
        harness.deps.pendingInteractions.listPendingThreadInteractions(
          thread.id,
        );
      harness.deps.pendingInteractions.respondToPluginInteraction({
        threadId: thread.id,
        interactionId: pluginInteraction!.id,
        value: { values: { API_KEY: "x" } },
      });
      await pending;
      const pluginEvents = lifecycleEvents().filter(
        (event) => event.interaction.id === pluginInteraction!.id,
      );
      expect(pluginEvents.map((event) => event.interaction.status)).toEqual([
        "pending",
        "resolved",
      ]);
      expect(pluginEvents[0]).toEqual({
        scope: { kind: "thread" },
        interaction: {
          id: pluginInteraction!.id,
          status: "pending",
          statusReason: null,
          origin: {
            kind: "plugin",
            pluginId: "secrets",
            rendererId: "secret-request",
          },
          payload: { kind: "plugin", title: "Add secrets" },
          resolution: null,
        },
      });
      expect(JSON.stringify(pluginEvents)).not.toContain("SENTINEL_FIELD");
      expect(pluginEvents[1]?.interaction.resolution).toEqual({
        kind: "plugin_submitted",
      });
    });
  });

  it("writes a command approval's lifecycle record before its item at every status that touches the item", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-item-order",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const writes = () =>
        harness.db
          .select()
          .from(eventTable)
          .where(eq(eventTable.threadId, thread.id))
          .orderBy(eventTable.sequence)
          .all()
          .filter(
            (row) =>
              row.type === "system/interaction/lifecycle" ||
              row.type.startsWith("item/"),
          )
          .map((row) => ({
            type: row.type,
            turnId: row.turnId,
            environmentId: row.environmentId,
            providerThreadId: row.providerThreadId,
          }));
      const lifecycle = {
        type: "system/interaction/lifecycle",
        turnId: "turn-item-order",
        environmentId: environment.id,
        providerThreadId: null,
      };
      const item = (type: "item/started" | "item/completed") => ({
        type,
        turnId: "turn-item-order",
        environmentId: environment.id,
        providerThreadId: "provider-thread-item-order",
      });

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-item-order",
          providerId: "codex",
          providerThreadId: "provider-thread-item-order",
          providerRequestId: "request-item-order",
          payload: createCommandApprovalPayload({ itemId: "item-order" }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(`Expected registration to succeed: ${created.reason}`);
      }
      expect(writes()).toEqual([lifecycle, item("item/started")]);

      const resolution = createDenyResolution();
      harness.deps.pendingInteractions.resolvePendingInteraction({
        threadId: thread.id,
        interactionId: created.interaction.id,
        resolution,
      });
      expect(writes().slice(2)).toEqual([lifecycle]);

      harness.db.transaction((tx) =>
        harness.deps.pendingInteractions.completeResolvingInteractionInTransaction(
          { db: tx, hub: harness.deps.hub },
          {
            interactionId: created.interaction.id,
            resolution,
          },
        ),
      );
      expect(writes().slice(3)).toEqual([lifecycle, item("item/completed")]);
    });
  });

  it("carries a provider's plugin-defined request to the plugin form and its answer back as a request answer", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-plugin-request",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "acp-cursor",
      });

      const request = {
        threadId: thread.id,
        turnId: "turn-plugin-request",
        providerId: "acp-cursor",
        providerThreadId: "provider-thread-plugin-request",
        providerRequestId: "request-plugin-request",
        payload: {
          kind: "secrets/secret-request" as const,
          title: "Add a token",
          data: { fields: ["SENTINEL_TOKEN"] },
        },
      };
      expect(
        registerPendingInteraction(
          harness.deps,
          harness.deps.pendingInteractions,
          request,
        ),
      ).toEqual({
        outcome: "rejected",
        reason: expect.stringContaining('Plugin "secrets" is not loaded'),
      });
      harness.deps.pendingInteractions.setPluginDirectory({
        isLoaded: (pluginId) => pluginId === "secrets",
      });
      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        request,
      );
      if (created.outcome === "rejected") {
        throw new Error(`Expected registration to succeed: ${created.reason}`);
      }

      const oversized = { blob: "x".repeat(64 * 1024) };
      expect(() =>
        harness.deps.pendingInteractions.respondToInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          value: oversized,
        }),
      ).toThrow(
        expect.objectContaining({
          status: 413,
          message: "Interaction response exceeds 64 KiB",
        }),
      );
      expect(() =>
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: { kind: "request_answer", value: oversized },
        }),
      ).toThrow(
        expect.objectContaining({
          status: 413,
          message: "Interaction response exceeds 64 KiB",
        }),
      );

      expect(() =>
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createDenyResolution(),
        }),
      ).toThrow("Only a request answer can resolve a plugin request");
      expect(() =>
        harness.deps.pendingInteractions.cancelPluginInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          reason: "user",
        }),
      ).toThrow("stop the turn instead");

      const answer = { kind: "request_answer", value: { TOKEN: "sentinel-x" } };
      const responding = harness.deps.pendingInteractions.respondToInteraction({
        threadId: thread.id,
        interactionId: created.interaction.id,
        value: { TOKEN: "sentinel-x" },
      });
      expect(responding).toMatchObject({
        id: created.interaction.id,
        status: "resolving",
        resolution: answer,
      });
      const completed = harness.db.transaction((tx) =>
        harness.deps.pendingInteractions.completeResolvingInteractionInTransaction(
          { db: tx, hub: harness.deps.hub },
          {
            interactionId: created.interaction.id,
            resolution: {
              kind: "request_answer",
              value: { TOKEN: "sentinel-x" },
            },
          },
        ),
      );
      expect(completed).toMatchObject({
        status: "resolved",
        resolution: answer,
      });

      const lifecycle = harness.db
        .select()
        .from(eventTable)
        .where(eq(eventTable.threadId, thread.id))
        .all()
        .filter((row) => row.type === "system/interaction/lifecycle")
        .map((row) => JSON.parse(row.data).interaction);
      expect(lifecycle.map((record) => record.status)).toEqual([
        "pending",
        "resolving",
        "resolved",
      ]);
      expect(lifecycle[2]).toMatchObject({
        payload: { kind: "secrets/secret-request", title: "Add a token" },
        resolution: { kind: "request_answer" },
      });
      expect(JSON.stringify(lifecycle)).not.toContain("SENTINEL_TOKEN");
      expect(JSON.stringify(lifecycle)).not.toContain("sentinel-x");
    });
  });

  it("allows command approvals to grant explicit session permissions for session decisions", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-command-grant",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-command-grant",
          providerId: "codex",
          providerThreadId: "provider-thread-command-grant",
          providerRequestId: "request-command-grant",
          payload: createCommandApprovalPayload({
            itemId: "item-command-grant",
            reason: "Needs network",
            command: "curl https://example.com",
            sessionGrant: {
              network: { enabled: true },
              fileSystem: null,
            },
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      expect(
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createAllowForSessionResolution({
            network: { enabled: true },
            fileSystem: null,
          }),
        }),
      ).toEqual(
        expect.objectContaining({
          status: "resolving",
          resolution: expect.objectContaining({
            decision: "allow_for_session",
            grantedPermissions: {
              network: { enabled: true },
              fileSystem: null,
            },
          }),
        }),
      );
    });
  });

  it("allows command session approvals when no BB session grant was requested", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-command-opaque-session",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "acp-opencode",
      });

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-command-opaque-session",
          providerId: "acp-opencode",
          providerThreadId: "provider-thread-command-opaque-session",
          providerRequestId: "request-command-opaque-session",
          payload: createCommandApprovalPayload({
            itemId: "item-command-opaque-session",
            reason: "Needs provider-side session approval",
            command: "cd backend && pnpm test",
            sessionGrant: null,
            availableDecisions: ["allow_once", "allow_for_session", "deny"],
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      expect(
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createAllowForSessionResolution(null),
        }),
      ).toEqual(
        expect.objectContaining({
          status: "resolving",
          resolution: {
            decision: "allow_for_session",
            grantedPermissions: null,
          },
        }),
      );
    });
  });

  it("rejects narrowed command session approval grants", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-narrowed-command-grant",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-narrowed-command-grant",
          providerId: "codex",
          providerThreadId: "provider-thread-narrowed-command-grant",
          providerRequestId: "request-narrowed-command-grant",
          payload: createCommandApprovalPayload({
            itemId: "item-narrowed-command-grant",
            reason: "Needs network and file access",
            command: "curl https://example.com > out.txt",
            sessionGrant: {
              network: { enabled: true },
              fileSystem: {
                read: [],
                write: ["/tmp/project"],
              },
            },
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      expect(() =>
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createAllowForSessionResolution({
            network: { enabled: true },
            fileSystem: null,
          }),
        }),
      ).toThrow(
        "Command and file-change session approvals must grant the requested session permissions exactly",
      );
    });
  });

  it("rejects session command approvals without granted permissions", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-null-session-grant",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-null-session-grant",
          providerId: "codex",
          providerThreadId: "provider-thread-null-session-grant",
          providerRequestId: "request-null-session-grant",
          payload: createCommandApprovalPayload({
            itemId: "item-null-session-grant",
            reason: "Needs network",
            command: "curl https://example.com",
            sessionGrant: {
              network: { enabled: true },
              fileSystem: null,
            },
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      expect(() =>
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createAllowForSessionResolution(null),
        }),
      ).toThrow(
        "Session approval resolutions must include granted permissions",
      );
    });
  });

  it("rejects file-change approvals that try to grant write-scope permissions", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-file-change-grant",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-file-change-grant",
          providerId: "codex",
          providerThreadId: "provider-thread-file-change-grant",
          providerRequestId: "request-file-change-grant",
          payload: createFileChangeApprovalPayload({
            itemId: "item-file-change-grant",
            reason: "Needs file write approval",
            writeScope: "/tmp/project",
            availableDecisions: ["allow_once", "allow_for_session", "deny"],
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      expect(() =>
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createAllowForSessionResolution({
            network: null,
            fileSystem: {
              read: [],
              write: ["/tmp/project"],
            },
          }),
        }),
      ).toThrow(
        "This approval subject and decision cannot grant the requested permissions",
      );
    });
  });

  it("rejects a second active interaction on the same thread", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-concurrent-reject",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-concurrent-reject-1",
          providerId: "codex",
          providerThreadId: "provider-thread-concurrent-reject",
          providerRequestId: "request-concurrent-reject-1",
          payload: createCommandApprovalPayload({
            itemId: "item-concurrent-reject-1",
            reason: "Needs approval",
            command: "git push",
            cwd: "/tmp/project",
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      expect(
        registerPendingInteraction(
          harness.deps,
          harness.deps.pendingInteractions,
          {
            threadId: thread.id,
            turnId: "turn-concurrent-reject-2",
            providerId: "codex",
            providerThreadId: "provider-thread-concurrent-reject",
            providerRequestId: "request-concurrent-reject-2",
            payload: createFileChangeApprovalPayload({
              itemId: "item-concurrent-reject-2",
              reason: "Needs file write approval",
            }),
          },
        ),
      ).toEqual({
        outcome: "rejected",
        reason: `Thread ${thread.id} is already awaiting user interaction`,
      });
    });
  });

  it("rejects command approvals with no available decisions", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-empty-decisions",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      expect(
        registerPendingInteraction(
          harness.deps,
          harness.deps.pendingInteractions,
          {
            threadId: thread.id,
            turnId: "turn-empty-decisions",
            providerId: "codex",
            providerThreadId: "provider-thread-empty-decisions",
            providerRequestId: "request-empty-decisions",
            payload: createCommandApprovalPayload({
              itemId: "item-empty-decisions",
              reason: "Needs approval",
              command: "git push",
              cwd: "/tmp/project",
              availableDecisions: [],
            }),
          },
        ),
      ).toEqual({
        outcome: "rejected",
        reason: "Approvals must include at least one available decision",
      });
    });
  });

  it("rejects resolving interrupted interactions", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-resolve-interrupted",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const created = registerPendingInteraction(
        harness.deps,
        harness.deps.pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-resolve-interrupted",
          providerId: "codex",
          providerThreadId: "provider-thread-resolve-interrupted",
          providerRequestId: "request-resolve-interrupted",
          payload: createCommandApprovalPayload({
            itemId: "item-resolve-interrupted",
            reason: "Needs approval",
            command: "git push",
            cwd: "/tmp/project",
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      harness.db.transaction((tx) =>
        harness.deps.pendingInteractions.interruptPendingInteractionInTransaction(
          { db: tx, hub: harness.deps.hub },
          {
            interactionId: created.interaction.id,
            reason: "Provider exited",
          },
        ),
      );

      expect(() =>
        harness.deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
          resolution: createAllowOnceResolution(),
        }),
      ).toThrowError(
        `Pending interaction ${created.interaction.id} is already interrupted`,
      );
    });
  });

  it("does not expire pending interactions on persistent hosts", async () => {
    await withTestHarness(async (harness) => {
      const pendingInteractions = new PendingInteractionLifecycle({
        config: harness.deps.config,
        db: harness.db,
        hub: harness.hub,
        lifecycleDedupers: harness.deps.lifecycleDedupers,
        logger: harness.deps.logger,
        machineAuth: harness.deps.machineAuth,
        providerRegistry: harness.deps.providerRegistry,
        aiServices: harness.deps.aiServices,
        pluginHostArtifacts: harness.deps.pluginHostArtifacts,
        skillTreeRegistry: harness.deps.skillTreeRegistry,
        telemetry: harness.deps.telemetry,
        terminalSessions: harness.deps.terminalSessions,
      });
      const { host } = seedHostSession(harness.deps, {
        id: "host-pending-interaction-no-expiry",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const created = registerPendingInteraction(
        harness.deps,
        pendingInteractions,
        {
          threadId: thread.id,
          turnId: "turn-no-expiry",
          providerId: "codex",
          providerThreadId: "provider-thread-no-expiry",
          providerRequestId: "request-no-expiry",
          payload: createCommandApprovalPayload({
            itemId: "item-no-expiry",
            reason: "Needs approval",
            command: "git push",
            cwd: "/tmp/project",
          }),
        },
      );
      if (created.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${created.reason}`,
        );
      }

      await sleep(50);

      expect(
        pendingInteractions.getThreadInteraction({
          threadId: thread.id,
          interactionId: created.interaction.id,
        }).status,
      ).toBe("pending");
    });
  });
});

it("rejects a late answer when an abort callback settled the waiter but failed to update storage", async () => {
  await withTestHarness(async (harness) => {
    const thread = seedPluginInteractionThread(harness.deps, "orphan");
    const controller = new AbortController();
    const pending = requestPluginInteraction(harness.deps, {
      threadId: thread.id,
      signal: controller.signal,
    });
    const [interaction] =
      harness.deps.pendingInteractions.listPendingThreadInteractions(thread.id);
    const cancel = vi
      .spyOn(harness.deps.pendingInteractions, "cancelPluginInteraction")
      .mockImplementationOnce(() => {
        throw new Error("storage temporarily unavailable");
      });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ outcome: "cancelled" });
    cancel.mockRestore();
    expect(() =>
      harness.deps.pendingInteractions.respondToPluginInteraction({
        threadId: thread.id,
        interactionId: interaction!.id,
        value: "lost answer",
      }),
    ).toThrow();
    expect(
      harness.deps.pendingInteractions.getThreadInteraction({
        threadId: thread.id,
        interactionId: interaction!.id,
      }),
    ).toMatchObject({ status: "interrupted", resolution: null });
  });
});
