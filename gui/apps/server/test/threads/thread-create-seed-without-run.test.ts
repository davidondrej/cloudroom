import {
  createEnvironment,
  ensurePersonalProject,
  getEnvironment,
  getThread,
  listEvents,
} from "@cloudroom/db";
import {
  PERSONAL_PROJECT_ID,
  turnRequestEventDataSchema,
  turnScope,
  type PermissionMode,
} from "@cloudroom/domain";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/errors.js";
import type { TelemetryService } from "../../src/services/system/telemetry.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { buildExecutionOptions } from "../../src/services/threads/thread-commands.js";
import {
  canThreadSpawnChild,
  MAX_THREAD_HIERARCHY_DEPTH,
} from "../../src/services/threads/thread-parent.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import { availableModelFixture } from "../helpers/available-models.js";
import { registerProviderHostRpcResponder } from "../helpers/host-rpc.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function threadStartTurnRequest(
  harness: { db: Parameters<typeof listEvents>[0] },
  threadId: string,
) {
  const events = listEvents(harness.db, { threadId });
  const turnRequest = events.find(
    (event) => event.type === "client/turn/requested",
  );
  if (!turnRequest) {
    throw new Error("Expected a client/turn/requested thread-start event");
  }
  return turnRequestEventDataSchema.parse(JSON.parse(turnRequest.data));
}

function installTelemetryCaptureSpy(harness: TestAppHarness) {
  const capture = vi.fn<TelemetryService["capture"]>();
  harness.deps.telemetry = { ...harness.deps.telemetry, capture };
  return capture;
}

describe("thread creation telemetry", () => {
  it("captures initial user messages", async () => {
    await withTestHarness(async (harness) => {
      const capture = installTelemetryCaptureSpy(harness);
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-create-telemetry",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-create-telemetry",
      });
      seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-create-telemetry",
      });

      await createThreadFromRequest(harness.deps, {
        environment: {
          type: "host",
          hostId: host.id,
          workspace: {
            type: "unmanaged",
            path: "/tmp/thread-create-telemetry",
          },
        },
        input: textInput("Start with telemetry"),
        origin: "app",
        projectId: project.id,
        providerId: "codex",
        startedOnBehalfOf: null,
      });

      expect(capture).toHaveBeenCalledWith({
        name: "user_message_sent",
        properties: {
          execution: "local",
          is_child_thread: false,
          message_source: "thread_create",
          provider: "codex",
        },
      });
    });
  });
});

describe("thread creation with startedOnBehalfOf (seed-without-run)", () => {
  it("persists an agent fork start while cloning the source provider session", async () => {
    await withTestHarness(async (harness) => {
      const capture = installTelemetryCaptureSpy(harness);
      const { host } = seedHostSession(harness.deps, {
        id: "host-seed-without-run",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/seed-without-run-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/seed-without-run-project",
      });
      const sourceThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      seedTurnStarted(harness.deps, {
        threadId: sourceThread.id,
        turnId: "turn-seed-without-run-source",
        providerThreadId: "provider-seed-without-run-source",
      });

      const input = textInput("Continue from the fork point");
      const fork = await createThreadFromRequest(harness.deps, {
        environment: {
          type: "host",
          hostId: host.id,
          workspace: {
            type: "unmanaged",
            path: "/tmp/seed-without-run-project",
          },
        },
        input,
        origin: "app",
        originKind: "fork",
        projectId: project.id,
        providerId: "codex",
        sourceThreadId: sourceThread.id,
        startedOnBehalfOf: {
          initiator: "agent",
          senderThreadId: sourceThread.id,
        },
      });

      const turnRequest = threadStartTurnRequest(harness, fork.id);
      expect(turnRequest.initiator).toBe("agent");
      expect(turnRequest.senderThreadId).toBe(sourceThread.id);
      expect(turnRequest.target).toEqual({ kind: "thread-start" });

      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === fork.id,
      );
      if (queuedStart.command.type !== "thread.start") {
        throw new Error("Expected a thread.start command");
      }
      expect(queuedStart.command.input).toEqual(input);
      expect(queuedStart.command.fork).toEqual({
        sourceProviderThreadId: "provider-seed-without-run-source",
      });
      const persistedFork = getThread(harness.db, fork.id);
      expect(persistedFork?.originKind).toBe("fork");
      expect(persistedFork?.sourceThreadId).toBe(sourceThread.id);
      expect(persistedFork?.parentThreadId).toBeNull();
      expect(persistedFork?.titleFallback).toBe("Continue from the fork point");
      expect(capture).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: "user_message_sent" }),
      );
    });
  });

  it("uses the source provider session at the requested source sequence", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-source-sequence-fork",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/source-sequence-fork-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/source-sequence-fork-project",
      });
      const sourceThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      seedTurnStarted(harness.deps, {
        threadId: sourceThread.id,
        turnId: "turn-earlier-source",
        providerThreadId: "provider-earlier-source",
        sequence: 5,
      });
      seedEvent(harness.deps, {
        threadId: sourceThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-earlier-source",
        sequence: 6,
        type: "turn/completed",
        scope: turnScope("turn-earlier-source"),
        data: {
          providerThreadId: "provider-earlier-source",
          status: "completed",
          providerCheckpointId: "checkpoint-earlier-source",
        },
      });
      seedTurnStarted(harness.deps, {
        threadId: sourceThread.id,
        turnId: "turn-later-source",
        providerThreadId: "provider-later-source",
        sequence: 9,
      });

      const forkInput = textInput("Continue from the earlier source sequence");
      const fork = await createThreadFromRequest(harness.deps, {
        environment: {
          type: "host",
          hostId: host.id,
          workspace: {
            type: "unmanaged",
            path: "/tmp/source-sequence-fork-project",
          },
        },
        input: forkInput,
        origin: "app",
        originKind: "fork",
        projectId: project.id,
        providerId: "codex",
        sourceSeqEnd: 5,
        sourceThreadId: sourceThread.id,
        startedOnBehalfOf: {
          initiator: "agent",
          senderThreadId: sourceThread.id,
        },
      });

      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === fork.id,
      );
      if (queuedStart.command.type !== "thread.start") {
        throw new Error("Expected a thread.start command");
      }
      expect(queuedStart.command.input).toEqual(forkInput);
      expect(queuedStart.command.fork).toEqual({
        sourceProviderThreadId: "provider-earlier-source",
        sourceProviderCheckpointId: "checkpoint-earlier-source",
      });
    });
  });

  it("dispatches a provider run for a normal user start (no startedOnBehalfOf)", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-normal-start",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/normal-start-project",
      });
      seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/normal-start-project",
      });

      const thread = await createThreadFromRequest(harness.deps, {
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "unmanaged", path: "/tmp/normal-start-project" },
        },
        input: textInput("Just start normally"),
        origin: "app",
        projectId: project.id,
        providerId: "codex",
        startedOnBehalfOf: null,
      });

      const turnRequest = threadStartTurnRequest(harness, thread.id);
      expect(turnRequest.initiator).toBe("user");
      expect(turnRequest.senderThreadId).toBeNull();

      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === thread.id,
      );
      expect(queuedStart.command.type).toBe("thread.start");
    });
  });
});

describe("canThreadSpawnChild", () => {
  it("reflects hierarchy depth against the cap", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-can-spawn-child",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/can-spawn-child-project",
      });

      const chain = [seedThread(harness.deps, { projectId: project.id })];
      while (chain.length < MAX_THREAD_HIERARCHY_DEPTH) {
        chain.push(
          seedThread(harness.deps, {
            projectId: project.id,
            parentThreadId: chain.at(-1)!.id,
          }),
        );
      }

      expect(
        chain.map((thread) => canThreadSpawnChild(harness.deps, { thread })),
      ).toEqual([...chain.slice(1).map(() => true), false]);
    });
  });

  it("applies the depth cap to source-derived side chats", async () => {
    await withTestHarness(async (harness) => {
      const path = "/tmp/source-derived-depth-cap-project";
      const { host } = seedHostSession(harness.deps, {
        id: "host-source-derived-depth-cap",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path,
      });

      let deepest = seedThread(harness.deps, { projectId: project.id });
      for (let level = 2; level <= MAX_THREAD_HIERARCHY_DEPTH; level += 1) {
        deepest = seedThread(harness.deps, {
          projectId: project.id,
          parentThreadId: deepest.id,
          ...(level === MAX_THREAD_HIERARCHY_DEPTH
            ? { environmentId: environment.id }
            : {}),
        });
      }

      let caught: ApiError | null = null;
      try {
        await createThreadFromRequest(harness.deps, {
          environment: {
            type: "host",
            hostId: host.id,
            workspace: { type: "unmanaged", path },
          },
          input: textInput("Side chat from a max-depth source"),
          origin: "app",
          originKind: "fork",
          projectId: project.id,
          providerId: "codex",
          sourceThreadId: deepest.id,
          startedOnBehalfOf: null,
        });
      } catch (error) {
        if (!(error instanceof ApiError)) {
          throw error;
        }
        caught = error;
      }

      expect(caught?.status).toBe(400);
      expect(caught?.body.code).toBe("parent_thread_invalid");
      expect(caught?.body.details).toEqual({
        reason: "too_deep",
        subject: "parent",
      });
    });
  });
});

describe("thread creation child-thread boundary validation", () => {
  async function withChildBoundaryHarness(
    name: string,
    run: (args: {
      harness: TestAppHarness;
      hostId: string;
      path: string;
      projectId: string;
      sourceThreadId: string;
    }) => Promise<void>,
  ) {
    await withTestHarness(async (harness) => {
      const path = `/tmp/${name}-project`;
      const { host } = seedHostSession(harness.deps, { id: `host-${name}` });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path,
      });
      const sourceThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      await run({
        harness,
        hostId: host.id,
        path,
        projectId: project.id,
        sourceThreadId: sourceThread.id,
      });
    });
  }

  async function captureCreateError(create: () => Promise<unknown>) {
    try {
      await create();
    } catch (error) {
      if (error instanceof ApiError) {
        return error;
      }
      throw error;
    }
    throw new Error("Expected createThreadFromRequest to throw an ApiError");
  }

  it("rejects startedOnBehalfOf whose senderThreadId differs from sourceThreadId", async () => {
    await withChildBoundaryHarness(
      "behalf-sender-mismatch",
      async ({ harness, hostId, path, projectId, sourceThreadId }) => {
        seedTurnStarted(harness.deps, {
          threadId: sourceThreadId,
          turnId: "turn-behalf-sender-mismatch",
          providerThreadId: "provider-behalf-sender-mismatch",
        });
        const error = await captureCreateError(() =>
          createThreadFromRequest(harness.deps, {
            environment: {
              type: "host",
              hostId,
              workspace: { type: "unmanaged", path },
            },
            input: textInput("Forged sender"),
            origin: "app",
            originKind: "fork",
            projectId,
            providerId: "codex",
            sourceThreadId,
            startedOnBehalfOf: {
              initiator: "agent",
              senderThreadId: "thr_someone_else",
            },
          }),
        );
        expect(error.status).toBe(400);
        expect(error.body.code).toBe("invalid_request");
        expect(error.body.message).toBe(
          "startedOnBehalfOf.senderThreadId must match sourceThreadId",
        );
      },
    );
  });

  it("rejects startedOnBehalfOf without a sourceThreadId", async () => {
    await withChildBoundaryHarness(
      "behalf-no-source",
      async ({ harness, hostId, path, projectId, sourceThreadId }) => {
        const error = await captureCreateError(() =>
          createThreadFromRequest(harness.deps, {
            environment: {
              type: "host",
              hostId,
              workspace: { type: "unmanaged", path },
            },
            input: textInput("Orphan anchor"),
            origin: "app",
            originKind: "fork",
            projectId,
            providerId: "codex",
            startedOnBehalfOf: {
              initiator: "agent",
              senderThreadId: sourceThreadId,
            },
          }),
        );
        expect(error.status).toBe(400);
        expect(error.body.code).toBe("invalid_request");
        expect(error.body.message).toBe("originKind requires a sourceThreadId");
      },
    );
  });

  it("rejects originKind without a sourceThreadId", async () => {
    await withChildBoundaryHarness(
      "origin-kind-no-source",
      async ({ harness, hostId, path, projectId }) => {
        const error = await captureCreateError(() =>
          createThreadFromRequest(harness.deps, {
            environment: {
              type: "host",
              hostId,
              workspace: { type: "unmanaged", path },
            },
            input: textInput("Parentless side chat"),
            origin: "app",
            originKind: "fork",
            projectId,
            providerId: "codex",
            startedOnBehalfOf: null,
          }),
        );
        expect(error.status).toBe(400);
        expect(error.body.code).toBe("invalid_request");
        expect(error.body.message).toBe("originKind requires a sourceThreadId");
      },
    );
  });

  it("runs a child an agent started for its parent and credits the parent", async () => {
    await withChildBoundaryHarness(
      "started-on-behalf-of-parent",
      async ({ harness, hostId, path, projectId, sourceThreadId }) => {
        const thread = await createThreadFromRequest(harness.deps, {
          environment: {
            type: "host",
            hostId,
            workspace: { type: "unmanaged", path },
          },
          input: textInput("Delegated task"),
          origin: "cli",
          parentThreadId: sourceThreadId,
          projectId,
          providerId: "codex",
          startedOnBehalfOf: {
            initiator: "agent",
            senderThreadId: sourceThreadId,
          },
        });

        const turnRequest = threadStartTurnRequest(harness, thread.id);
        expect(turnRequest.initiator).toBe("agent");
        expect(turnRequest.senderThreadId).toBe(sourceThreadId);
        const queuedStart = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.start" && command.threadId === thread.id,
        );
        expect(queuedStart.command.type).toBe("thread.start");
      },
    );
  });

  it("accepts a fork anchored to its source thread", async () => {
    await withChildBoundaryHarness(
      "valid-fork",
      async ({ harness, hostId, path, projectId, sourceThreadId }) => {
        seedTurnStarted(harness.deps, {
          threadId: sourceThreadId,
          turnId: "turn-valid-fork-source",
          providerThreadId: "provider-valid-fork-source",
        });

        const fork = await createThreadFromRequest(harness.deps, {
          environment: {
            type: "host",
            hostId,
            workspace: { type: "unmanaged", path },
          },
          input: textInput("Forked anchor"),
          origin: "app",
          originKind: "fork",
          projectId,
          providerId: "codex",
          sourceThreadId,
          startedOnBehalfOf: {
            initiator: "agent",
            senderThreadId: sourceThreadId,
          },
        });
        const persistedFork = getThread(harness.db, fork.id);
        expect(persistedFork?.originKind).toBe("fork");
        expect(persistedFork?.sourceThreadId).toBe(sourceThreadId);
        expect(persistedFork?.parentThreadId).toBeNull();
        expect(persistedFork?.titleFallback).toBe("Forked anchor");
      },
    );
  });

  it("allows an empty-input native fork to start idle", async () => {
    await withChildBoundaryHarness(
      "empty-native-fork",
      async ({ harness, hostId, path, projectId, sourceThreadId }) => {
        seedTurnStarted(harness.deps, {
          threadId: sourceThreadId,
          turnId: "turn-parent",
          providerThreadId: "provider-parent-session",
        });

        const fork = await createThreadFromRequest(harness.deps, {
          environment: {
            type: "host",
            hostId,
            workspace: { type: "unmanaged", path },
          },
          input: [],
          origin: "app",
          originKind: "fork",
          projectId,
          providerId: "codex",
          sourceThreadId,
          startedOnBehalfOf: {
            initiator: "agent",
            senderThreadId: sourceThreadId,
          },
        });
        const queued = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.start" && command.threadId === fork.id,
        );
        if (queued.command.type !== "thread.start") {
          throw new Error("Expected a thread.start command");
        }
        expect(queued.command.input).toEqual([]);
        expect(queued.command.fork).toEqual({
          sourceProviderThreadId: "provider-parent-session",
        });
      },
    );
  });

  it.each<PermissionMode>(["accept-edits", "auto", "full"])(
    "keeps the requested permission mode when forking from a %s source",
    async (sourcePermissionMode) => {
      const permissionMode: PermissionMode =
        sourcePermissionMode === "full" ? "accept-edits" : "full";
      await withChildBoundaryHarness(
        `side-chat-native-fork-${sourcePermissionMode}`,
        async ({ harness, hostId, path, projectId, sourceThreadId }) => {
          seedThreadRuntimeState(harness.deps, {
            environmentId:
              getThread(harness.db, sourceThreadId)?.environmentId ?? null,
            permissionMode: sourcePermissionMode,
            inputText: "Source question",
            model: "gpt-5",
            reasoningLevel: "medium",
            serviceTier: "default",
            threadId: sourceThreadId,
            providerThreadId: "provider-parent-session",
          });

          const sideChat = await createThreadFromRequest(harness.deps, {
            environment: {
              type: "host",
              hostId,
              workspace: { type: "unmanaged", path },
            },
            input: textInput("What did this code do?"),
            origin: "app",
            originKind: "fork",
            projectId,
            providerId: "codex",
            permissionMode,
            sourceThreadId,
            startedOnBehalfOf: null,
          });

          const queuedStart = await waitForQueuedCommand(
            harness,
            ({ command }) =>
              command.type === "thread.start" &&
              command.threadId === sideChat.id,
          );
          if (queuedStart.command.type !== "thread.start") {
            throw new Error("Expected a thread.start command");
          }
          expect(queuedStart.command.fork).toEqual({
            sourceProviderThreadId: "provider-parent-session",
          });
          expect(queuedStart.command.options).toMatchObject({
            permissionMode,
            permissionScope: permissionMode === "full" ? "full" : "workspace",
            approvalReviewer: permissionMode === "full" ? null : "user",
            permissionEscalation: permissionMode === "full" ? null : "ask",
          });
          const startInputText = queuedStart.command.input
            .filter((entry) => entry.type === "text")
            .map((entry) => entry.text)
            .join("\n");
          expect(startInputText).toContain("What did this code do?");

          seedThreadRuntimeState(harness.deps, {
            environmentId:
              getThread(harness.db, sourceThreadId)?.environmentId ?? null,
            permissionMode: sourcePermissionMode === "full" ? "auto" : "full",
            threadId: sourceThreadId,
            inputText: "Source permission changed",
            model: "gpt-5",
            providerThreadId: "provider-parent-session",
            reasoningLevel: "medium",
            sequenceStart: 10,
            serviceTier: "default",
          });
          const sideChatExecution = await buildExecutionOptions(
            harness.deps,
            { model: "gpt-5" },
            { threadId: sideChat.id },
          );
          expect(sideChatExecution.permissionMode).toBe(permissionMode);
        },
      );
    },
  );

  it("preloads an empty-input side chat by cloning the source provider session", async () => {
    await withChildBoundaryHarness(
      "empty-side-chat-preload",
      async ({ harness, hostId, path, projectId, sourceThreadId }) => {
        const capture = installTelemetryCaptureSpy(harness);
        seedTurnStarted(harness.deps, {
          threadId: sourceThreadId,
          turnId: "turn-parent",
          providerThreadId: "provider-parent-session",
        });

        const sideChat = await createThreadFromRequest(harness.deps, {
          environment: {
            type: "host",
            hostId,
            workspace: { type: "unmanaged", path },
          },
          input: [],
          origin: "app",
          originKind: "fork",
          projectId,
          providerId: "codex",
          sourceThreadId,
          startedOnBehalfOf: null,
        });

        const queuedStart = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.start" && command.threadId === sideChat.id,
        );
        if (queuedStart.command.type !== "thread.start") {
          throw new Error("Expected a thread.start command");
        }
        expect(queuedStart.command.input).toEqual([]);
        expect(queuedStart.command.fork).toEqual({
          sourceProviderThreadId: "provider-parent-session",
        });
        expect(capture).not.toHaveBeenCalledWith(
          expect.objectContaining({ name: "user_message_sent" }),
        );

        await reportQueuedCommandSuccess(harness, queuedStart, {
          providerThreadId: "provider-side-chat-session",
        });

        const persistedSideChat = getThread(harness.db, sideChat.id);
        expect(persistedSideChat?.status).toBe("idle");
        expect(persistedSideChat?.originKind).toBe("fork");
        expect(persistedSideChat?.sourceThreadId).toBe(sourceThreadId);
        expect(persistedSideChat?.parentThreadId).toBeNull();
        expect(persistedSideChat?.visibility).toBe("visible");
      },
    );
  });

  it("shares a preloaded personal workspace with its side chat", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-personal-side-chat",
      });
      seedPrimaryHost(harness.deps, host.id);
      ensurePersonalProject(harness.db);
      const environment = createEnvironment(harness.db, harness.hub, {
        providerOwnsPath: false,
        hostId: host.id,
        projectId: PERSONAL_PROJECT_ID,
        path: "/tmp/personal-side-chat",
        status: "ready",
        environmentProvider: {
          environmentProviderId: "personal-workspace",
          instanceKey: null,
          selection: {
            machine: { type: "existing", hostId: host.id },
            inputs: null,
          },
        },
      });
      const sourceThread = seedThread(harness.deps, {
        projectId: PERSONAL_PROJECT_ID,
        environmentId: environment.id,
      });
      seedTurnStarted(harness.deps, {
        threadId: sourceThread.id,
        turnId: "turn-personal-side-chat-source",
        providerThreadId: "provider-personal-side-chat-source",
      });

      const sideChat = await createThreadFromRequest(harness.deps, {
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "personal" },
        },
        input: [],
        origin: "app",
        originKind: "fork",
        projectId: PERSONAL_PROJECT_ID,
        providerId: "codex",
        sourceThreadId: sourceThread.id,
        startedOnBehalfOf: null,
      });

      expect(getEnvironment(harness.db, environment.id)?.status).toBe("ready");
      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === sideChat.id,
      );
      if (queuedStart.command.type !== "thread.start") {
        throw new Error("Expected a thread.start command");
      }
      const child = getThread(harness.db, sideChat.id);
      expect(child).toMatchObject({
        originKind: "fork",
        sourceThreadId: sourceThread.id,
      });
      expect(child?.environmentId).not.toBeNull();
      expect(child?.environmentId).toBe(environment.id);
      expect(queuedStart.command.input).toEqual([]);
      expect(queuedStart.command.fork).toEqual({
        sourceProviderThreadId: "provider-personal-side-chat-source",
      });
    });
  });

  it("allows a personal fork to reuse its switched source environment", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-personal-fork-source-environment",
      });
      ensurePersonalProject(harness.db);
      const sourceEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/tmp/personal-fork-source",
        projectId: PERSONAL_PROJECT_ID,
      });
      const sourceThread = seedThread(harness.deps, {
        environmentId: sourceEnvironment.id,
        projectId: PERSONAL_PROJECT_ID,
      });
      seedTurnStarted(harness.deps, {
        environmentId: sourceEnvironment.id,
        providerThreadId: "provider-personal-fork-source",
        threadId: sourceThread.id,
        turnId: "turn-personal-fork-source",
      });

      const fork = await createThreadFromRequest(harness.deps, {
        environment: {
          type: "reuse",
          environmentId: sourceEnvironment.id,
        },
        input: textInput("Reuse the switched source environment"),
        origin: "app",
        originKind: "fork",
        projectId: PERSONAL_PROJECT_ID,
        providerId: "codex",
        sourceThreadId: sourceThread.id,
        startedOnBehalfOf: null,
      });

      expect(getThread(harness.db, fork.id)?.environmentId).toBe(
        sourceEnvironment.id,
      );
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === fork.id,
      );
      if (queued.command.type !== "thread.start") {
        throw new Error("Expected a thread.start command");
      }
      expect(queued.command.fork).toEqual({
        sourceProviderThreadId: "provider-personal-fork-source",
      });
    });
  });

  it("lets a personal parent teleported back from Cloud spawn a child", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-personal-spawn-teleported",
      });
      ensurePersonalProject(harness.db);
      const parentEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/tmp/personal-spawn-teleported",
        projectId: PERSONAL_PROJECT_ID,
      });
      const parent = seedThread(harness.deps, {
        environmentId: parentEnvironment.id,
        projectId: PERSONAL_PROJECT_ID,
      });

      for (const environment of [
        { type: "project-default" as const },
        {
          type: "host" as const,
          hostId: host.id,
          workspace: { type: "personal" as const },
        },
        { type: "reuse" as const, environmentId: parentEnvironment.id },
      ]) {
        const child = await createThreadFromRequest(harness.deps, {
          environment,
          input: textInput("Child of a teleported parent"),
          origin: "app",
          parentThreadId: parent.id,
          projectId: PERSONAL_PROJECT_ID,
          providerId: "codex",
          startedOnBehalfOf: null,
        });
        expect(getThread(harness.db, child.id)).toMatchObject({
          environmentId: parentEnvironment.id,
          parentThreadId: parent.id,
        });
      }
    });
  });

  it("rejects a personal fork that reuses a different unmanaged environment", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-personal-fork-different-environment",
      });
      ensurePersonalProject(harness.db);
      const sourceEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/tmp/personal-fork-source",
        projectId: PERSONAL_PROJECT_ID,
      });
      const otherEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/tmp/personal-fork-other",
        projectId: PERSONAL_PROJECT_ID,
      });
      const sourceThread = seedThread(harness.deps, {
        environmentId: sourceEnvironment.id,
        projectId: PERSONAL_PROJECT_ID,
      });
      seedTurnStarted(harness.deps, {
        environmentId: sourceEnvironment.id,
        providerThreadId: "provider-personal-fork-source",
        threadId: sourceThread.id,
        turnId: "turn-personal-fork-source",
      });

      await expect(
        createThreadFromRequest(harness.deps, {
          environment: {
            type: "reuse",
            environmentId: otherEnvironment.id,
          },
          input: textInput("Reuse only the source environment"),
          origin: "app",
          originKind: "fork",
          projectId: PERSONAL_PROJECT_ID,
          providerId: "codex",
          sourceThreadId: sourceThread.id,
          startedOnBehalfOf: null,
        }),
      ).rejects.toMatchObject({
        body: {
          message: "Personal project threads must reuse a personal workspace",
        },
        status: 409,
      });
    });
  });

  it("auto-sends a queued first side-chat message after preload settles idle", async () => {
    await withChildBoundaryHarness(
      "empty-side-chat-preload-queued-message",
      async ({ harness, hostId, path, projectId, sourceThreadId }) => {
        seedTurnStarted(harness.deps, {
          threadId: sourceThreadId,
          turnId: "turn-parent",
          providerThreadId: "provider-parent-session",
        });

        const sideChat = await createThreadFromRequest(harness.deps, {
          environment: {
            type: "host",
            hostId,
            workspace: { type: "unmanaged", path },
          },
          input: [],
          origin: "app",
          originKind: "fork",
          projectId,
          providerId: "codex",
          sourceThreadId,
          startedOnBehalfOf: null,
        });

        const queuedStart = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.start" && command.threadId === sideChat.id,
        );
        if (queuedStart.command.type !== "thread.start") {
          throw new Error("Expected a thread.start command");
        }

        seedQueuedMessage(harness.deps, {
          threadId: sideChat.id,
          content: textInput("Queued first side-chat question"),
          permissionMode: "auto",
        });

        await reportQueuedCommandSuccess(harness, queuedStart, {
          providerThreadId: "provider-side-chat-session",
        });

        const queuedTurnSubmit = await waitForQueuedCommandAfter(
          harness,
          queuedStart.row.cursor,
          ({ command }) =>
            command.type === "turn.submit" && command.threadId === sideChat.id,
        );
        if (queuedTurnSubmit.command.type !== "turn.submit") {
          throw new Error("Expected a turn.submit command");
        }
        const turnSubmitText = queuedTurnSubmit.command.input
          .filter((entry) => entry.type === "text")
          .map((entry) => entry.text)
          .join("\n");
        expect(turnSubmitText).toContain("Queued first side-chat question");
      },
    );
  });

  it("rejects a fork whose target provider differs from the source provider", async () => {
    await withTestHarness(async (harness) => {
      const path = "/tmp/fork-cross-provider-project";
      const { host } = seedHostSession(harness.deps, {
        id: "host-fork-cross-provider",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path,
      });
      const sourceThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "acp-amp",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "acp-amp-session",
        threadId: sourceThread.id,
      });

      const error = await captureCreateError(() =>
        createThreadFromRequest(harness.deps, {
          environment: {
            type: "host",
            hostId: host.id,
            workspace: { type: "unmanaged", path },
          },
          input: textInput("Fork into another provider"),
          origin: "app",
          originKind: "fork",
          projectId: project.id,
          providerId: "codex",
          sourceThreadId: sourceThread.id,
          startedOnBehalfOf: null,
        }),
      );
      expect(error.status).toBe(400);
      expect(error.body.code).toBe("fork_source_session_unavailable");
    });
  });

  it("rejects a fork when the source has no active provider session", async () => {
    await withChildBoundaryHarness(
      "fork-no-source-session",
      async ({ harness, hostId, path, projectId, sourceThreadId }) => {
        const error = await captureCreateError(() =>
          createThreadFromRequest(harness.deps, {
            environment: {
              type: "host",
              hostId,
              workspace: { type: "unmanaged", path },
            },
            input: textInput("Fork without a source session"),
            origin: "app",
            originKind: "fork",
            projectId,
            providerId: "codex",
            sourceThreadId,
            startedOnBehalfOf: {
              initiator: "agent",
              senderThreadId: sourceThreadId,
            },
          }),
        );
        expect(error.status).toBe(400);
        expect(error.body.code).toBe("fork_source_session_unavailable");
        // Nothing finished to copy, natively or as text.
        expect(error.body.message).toBe(
          "Fork from a message whose turn has finished.",
        );
      },
    );
  });

  it("rejects a side chat when the source has no active provider session", async () => {
    await withChildBoundaryHarness(
      "side-chat-no-source-session",
      async ({ harness, hostId, path, projectId, sourceThreadId }) => {
        const error = await captureCreateError(() =>
          createThreadFromRequest(harness.deps, {
            environment: {
              type: "host",
              hostId,
              workspace: { type: "unmanaged", path },
            },
            input: textInput("Side chat without source session"),
            origin: "app",
            originKind: "fork",
            projectId,
            providerId: "codex",
            sourceThreadId,
            startedOnBehalfOf: null,
          }),
        );
        expect(error.status).toBe(400);
        expect(error.body.code).toBe("fork_source_session_unavailable");
        // Nothing finished to copy, natively or as text.
        expect(error.body.message).toBe(
          "Fork from a message whose turn has finished.",
        );
      },
    );
  });

  it("accepts a side chat with a source and null startedOnBehalfOf", async () => {
    await withChildBoundaryHarness(
      "valid-side-chat",
      async ({ harness, hostId, path, projectId, sourceThreadId }) => {
        seedTurnStarted(harness.deps, {
          threadId: sourceThreadId,
          turnId: "turn-valid-side-chat-source",
          providerThreadId: "provider-valid-side-chat-source",
        });

        const sideChat = await createThreadFromRequest(harness.deps, {
          environment: {
            type: "host",
            hostId,
            workspace: { type: "unmanaged", path },
          },
          input: textInput("Side chat opener"),
          origin: "app",
          originKind: "fork",
          projectId,
          providerId: "codex",
          sourceThreadId,
          startedOnBehalfOf: null,
        });
        const persistedSideChat = getThread(harness.db, sideChat.id);
        expect(persistedSideChat?.originKind).toBe("fork");
        expect(persistedSideChat?.sourceThreadId).toBe(sourceThreadId);
        expect(persistedSideChat?.parentThreadId).toBeNull();
      },
    );
  });

  it("creates a fresh Local side chat on another harness and preserves its quoted seed across pre-send harness switches", async () => {
    await withTestHarness(async (harness) => {
      const path = "/tmp/decoupled-local-side-chat-project";
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-decoupled-local-side-chat",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path,
      });
      const sourceThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
      });
      const rpc = registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        modelsByProviderId: {
          "claude-code": {
            models: [availableModelFixture({ model: "claude-opus-4-6" })],
            selectedOnlyModels: [],
          },
          codex: {
            models: [availableModelFixture({ model: "gpt-5.4" })],
            selectedOnlyModels: [],
          },
        },
      });
      try {
        const created = await harness.app.request("/api/v1/threads/fork", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sourceThreadId: sourceThread.id,
            fresh: true,
            visibility: "hidden",
            providerId: "claude-code",
            model: "claude-opus-4-6",
            reasoningLevel: "low",
            agentContextSeed: [
              {
                type: "text",
                text: "Replying to:\n\nCheck foo()",
                mentions: [],
                visibility: "agent-only",
              },
            ],
          }),
        });
        expect(created.status, await created.clone().text()).toBe(201);
        const sideChat = (await created.json()) as {
          id: string;
          providerId: string;
          status: string;
        };
        expect(sideChat.providerId).toBe("claude-code");
        await expect
          .poll(() => getThread(harness.db, sideChat.id)?.status)
          .toBe("idle");

        const switched = await harness.app.request(
          `/api/v1/threads/${sideChat.id}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              providerId: "codex",
              model: "gpt-5.4",
              reasoningLevel: "low",
            }),
          },
        );
        expect(switched.status, await switched.clone().text()).toBe(200);
        expect(getThread(harness.db, sideChat.id)?.providerId).toBe("codex");
        // No "Switched from ..." divider on an unstarted side chat, and the quoted seed stays intact.
        expect(
          listEvents(harness.db, { threadId: sideChat.id }).some(
            (event) =>
              event.type === "system/operation" &&
              JSON.parse(event.data).operation === "harness_switch",
          ),
        ).toBe(false);
        expect(threadStartTurnRequest(harness, sideChat.id).input).toEqual([
          {
            type: "text",
            text: "Replying to:\n\nCheck foo()",
            mentions: [],
            visibility: "agent-only",
          },
        ]);
      } finally {
        rpc.unregister();
      }
    });
  });
});
