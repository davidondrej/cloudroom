import {
  archiveThread,
  createPendingInteraction,
  createQueuedThreadMessage,
  getQueuedThreadMessage,
  getThread,
  listEvents,
  listQueuedThreadMessages,
  markThreadDeleted,
  setPendingInteractionResolved,
} from "@cloudroom/db";
import type { EnvironmentRow } from "@cloudroom/db";
import {
  changedMessageSchema,
  turnScope,
  type ServiceTier,
  type Thread,
  type ThreadChangedMessage,
} from "@cloudroom/domain";
import { groupHostDaemonEvents } from "@cloudroom/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelemetryService } from "../../src/services/system/telemetry.js";
import * as threadEvents from "../../src/services/threads/thread-events.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import {
  createAutomaticQueuedMessageEligibility,
  createQueuedMessageForThread,
  sendNextQueuedMessageIfPresent,
  sendQueuedMessage,
  sendQueuedMessageNow,
} from "../../src/services/threads/queued-messages.js";
import { queueParentSystemMessage } from "../../src/services/threads/parent-system-messages.js";
import { buildChildThreadTurnStatusBatchInput } from "../../src/services/threads/child-thread-notifications.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { handleUpdateEnvironmentDirectoryToolCall } from "../../src/services/threads/thread-environment-directory.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { buildExecutionOptions } from "../../src/services/threads/thread-commands.js";
import * as threadCommands from "../../src/services/threads/thread-commands.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import {
  internalAuthHeaders,
  listQueuedThreadCommands,
  reportQueuedCommandError,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedStoredEvent,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

interface IdleThreadFixture {
  environment: EnvironmentRow;
  sessionId: string;
  thread: Thread;
}

interface SeedIdleThreadFixtureArgs {
  harness: TestAppHarness;
  value: number;
}

interface SeedProviderThreadFixtureArgs extends SeedIdleThreadFixtureArgs {
  status?: "active" | "idle" | "starting";
  serviceTier?: ServiceTier;
  providerId?: string;
}

afterEach(() => vi.restoreAllMocks());

function seedProviderThreadFixture(
  args: SeedProviderThreadFixtureArgs,
): IdleThreadFixture {
  const { host, session } = seedHostSession(args.harness.deps, {
    id: `host-send-dispatch-${args.value}`,
  });
  const { project } = seedProjectWithSource(args.harness.deps, {
    hostId: host.id,
    path: `/tmp/send-dispatch-${args.value}`,
  });
  const environment = seedEnvironment(args.harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/send-dispatch-${args.value}`,
    status: "ready",
  });
  const thread = seedThread(args.harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: args.status ?? "idle",
    ...(args.providerId === undefined ? {} : { providerId: args.providerId }),
  });
  seedThreadRuntimeState(args.harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-send-dispatch-${args.value}`,
    serviceTier: args.serviceTier,
    threadId: thread.id,
  });

  return { environment, sessionId: session.id, thread };
}

function seedColdIdleThreadFixture(
  args: SeedIdleThreadFixtureArgs,
): IdleThreadFixture {
  const { host, session } = seedHostSession(args.harness.deps, {
    id: `host-send-dispatch-${args.value}`,
  });
  const { project } = seedProjectWithSource(args.harness.deps, {
    hostId: host.id,
    path: `/tmp/send-dispatch-${args.value}`,
  });
  const environment = seedEnvironment(args.harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/send-dispatch-${args.value}`,
    status: "ready",
  });
  const thread = seedThread(args.harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });

  return { environment, sessionId: session.id, thread };
}

/** Holds the first host preparation open, as a busy machine does, until `release`. */
function holdFirstPreparation() {
  const real = threadCommands.prepareTurnSubmitCommandPayload;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  let first = true;
  vi.spyOn(threadCommands, "prepareTurnSubmitCommandPayload").mockImplementation(
    async (...args) => {
      if (first) {
        first = false;
        reach();
        await held;
      }
      return real(...args);
    },
  );
  return { reached, release };
}

function installTelemetryCaptureSpy(harness: TestAppHarness) {
  const capture = vi.fn<TelemetryService["capture"]>();
  harness.deps.telemetry = { ...harness.deps.telemetry, capture };
  return capture;
}

function parseThreadMessages(
  messages: readonly string[],
): ThreadChangedMessage[] {
  return messages.flatMap((raw) => {
    const message = changedMessageSchema.parse(JSON.parse(raw));
    return message.entity === "thread" ? [message] : [];
  });
}

describe("queued message dispatch hook", () => {
  it("rolls back and sends no host command when the idle thread was archived between claim and dispatch", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedProviderThreadFixture({ harness, value: 1 });
      const queued = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("queued while idle"),
        waitingOn: { kind: "time" },
        sendAt: Date.now() - 1,
      });
      const sending = runQueuedMessageDispatch(harness.deps, {
        kind: "time-reached",
        now: Date.now(),
      });
      expect(getQueuedThreadMessage(harness.db, queued.id)).toMatchObject({
        claimedAt: expect.any(Number),
      });

      archiveThread(harness.db, harness.hub, thread.id);
      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "idle",
        archivedAt: expect.any(Number),
      });

      await expect(sending).resolves.toBeUndefined();

      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toHaveLength(0);
      expect(
        listQueuedThreadCommands(harness, "thread.start", thread.id),
      ).toHaveLength(0);
      expect(getQueuedThreadMessage(harness.db, queued.id)).toMatchObject({
        claimedAt: null,
        failureReason: null,
      });
      expect(
        listQueuedThreadMessages(harness.db, thread.id).map((row) => row.id),
      ).toContain(queued.id);
      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "idle",
      });
    });
  });

  it("rolls back and sends no host command when the idle thread was deleted between claim and dispatch", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedProviderThreadFixture({ harness, value: 2 });
      const queued = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("queued while idle"),
      });
      const sending = sendNextQueuedMessageIfPresent(harness.deps, {
        threadId: thread.id,
      });
      expect(getQueuedThreadMessage(harness.db, queued.id)).toMatchObject({
        claimedAt: expect.any(Number),
      });

      markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });

      await expect(sending).resolves.toBe(false);

      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toHaveLength(0);
      expect(
        listQueuedThreadCommands(harness, "thread.start", thread.id),
      ).toHaveLength(0);
      expect(getQueuedThreadMessage(harness.db, queued.id)).toMatchObject({
        claimedAt: null,
        failureReason: null,
      });
    });
  });
});

describe("queued message auto-send notification", () => {
  it("carries the statusChange row snapshot when the auto-send activates the thread", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedProviderThreadFixture({ harness, value: 41 });
      const queued = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("queued while idle"),
        reasoningLevel: "high",
      });
      const socket = createMockHubSocket();
      harness.hub.subscribe(socket, { kind: "thread-list" });

      await sendQueuedMessage(harness.deps, {
        claimPolicy: {
          kind: "automatic",
          isEligible: createAutomaticQueuedMessageEligibility(
            harness.deps,
            { now: Date.now(), thread },
          ),
        },
        threadId: thread.id,
        queuedMessageId: queued.id,
        mode: "auto",
      });

      expect(
        threadEvents.getLastExecutionOptions(harness.deps, thread.id),
      ).toMatchObject({ model: queued.model, reasoningLevel: "high" });
      const statusMessages = parseThreadMessages(socket.messages).filter(
        (message) =>
          message.id === thread.id &&
          message.changes.includes("status-changed"),
      );
      expect(statusMessages.length).toBeGreaterThan(0);
      for (const message of statusMessages) {
        expect(message.metadata?.statusChange).toMatchObject({
          status: "active",
          runtime: { displayStatus: "active" },
        });
      }
    });
  });
});

describe("user message telemetry", () => {
  it("captures direct user sends", async () => {
    await withTestHarness(async (harness) => {
      const capture = installTelemetryCaptureSpy(harness);
      const { environment, thread } = seedColdIdleThreadFixture({
        harness,
        value: 5,
      });

      await sendThreadMessage(harness.deps, {
        environment,
        payload: {
          input: textInput("telemetry user send"),
          mode: "start",
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        thread,
        trigger: "user",
      });

      expect(
        threadEvents.getLastExecutionOptions(harness.deps, thread.id),
      ).toMatchObject({ model: "gpt-5", reasoningLevel: "medium" });
      expect(capture).toHaveBeenCalledWith({
        name: "user_message_sent",
        properties: {
          execution: "local",
          is_child_thread: false,
          message_source: "thread_send",
          provider: "codex",
        },
      });
    });
  });

  it("does not capture agent-originated sends", async () => {
    await withTestHarness(async (harness) => {
      const capture = installTelemetryCaptureSpy(harness);
      const { environment, thread } = seedColdIdleThreadFixture({
        harness,
        value: 6,
      });
      const senderThread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: thread.projectId,
      });

      await sendThreadMessage(harness.deps, {
        environment,
        payload: {
          input: textInput("telemetry agent send"),
          mode: "start",
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          senderThreadId: senderThread.id,
          serviceTier: "default",
        },
        thread,
        trigger: "user",
      });

      expect(capture).not.toHaveBeenCalled();
    });
  });
});

describe("startup queue waits", () => {
  it("steers provisioning input into the first turn in queue order", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedProviderThreadFixture({
        harness,
        status: "starting",
        value: 69,
      });
      for (const text of [
        "first provisioning steer",
        "second provisioning steer",
      ]) {
        await expect(
          acceptThreadSendRequest(harness.deps, {
            payload: {
              input: textInput(text),
              mode: "steer-if-active",
            },
            thread,
          }),
        ).resolves.toMatchObject({
          delivery: "queued",
          queuedMessage: { waitingOn: { kind: "provisioning" } },
        });
      }

      await runQueuedMessageDispatch(harness.deps, {
        kind: "workspace-ready",
        threadId: thread.id,
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toMatchObject([
        { waitingOn: JSON.stringify({ kind: "provisioning" }) },
        { waitingOn: JSON.stringify({ kind: "provisioning" }) },
      ]);

      applyLoggedThreadLifecycleEvent(harness.deps, {
        event: { type: "run.started" },
        threadId: thread.id,
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-send-dispatch-69",
        threadId: thread.id,
        turnId: "turn-send-dispatch-69",
      });
      await runQueuedMessageDispatch(harness.deps, {
        kind: "turn-started",
        threadId: thread.id,
      });

      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toMatchObject([
        {
          input: textInput("first provisioning steer"),
          target: {
            mode: "auto",
            expectedTurnId: "turn-send-dispatch-69",
          },
        },
        {
          input: textInput("second provisioning steer"),
          target: {
            mode: "auto",
            expectedTurnId: "turn-send-dispatch-69",
          },
        },
      ]);
    });
  });

  it("keeps an explicitly steered queued row parked during provisioning", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedProviderThreadFixture({
        harness,
        status: "starting",
        value: 70,
      });
      const queued = seedQueuedMessage(harness.deps, {
        content: textInput("steer this queued row when ready"),
        threadId: thread.id,
        waitingOn: { kind: "thread-busy" },
      });

      await expect(
        sendQueuedMessageNow(harness.deps, {
          mode: "steer",
          queuedMessageId: queued.id,
          threadId: thread.id,
        }),
      ).resolves.toMatchObject({
        delivery: "queued",
        queuedMessage: {
          id: queued.id,
          waitingOn: { kind: "provisioning" },
        },
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toMatchObject([
        {
          id: queued.id,
          waitingOn: JSON.stringify({ kind: "provisioning" }),
        },
      ]);
    });
  });

  it("starts a new turn when startup settles before its queued wake", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedProviderThreadFixture({
        harness,
        status: "idle",
        value: 66,
      });
      seedQueuedMessage(harness.deps, {
        content: textInput("follow-up after startup settled"),
        threadId: thread.id,
        waitingOn: { kind: "turn-starting" },
      });

      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });

      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([
        expect.objectContaining({
          input: textInput("follow-up after startup settled"),
          target: { mode: "start" },
        }),
      ]);
    });
  });

  it.each([
    ["archive", "archived"],
    ["delete", "deleted"],
  ] as const)(
    "does not queue an ordinary follow-up after %s wins before admission",
    async (operation, reason) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedProviderThreadFixture({
          harness,
          status: "active",
          value: operation === "archive" ? 63 : 64,
        });
        if (operation === "archive") {
          archiveThread(harness.db, harness.hub, thread.id);
        } else {
          markThreadDeleted(harness.db, harness.hub, {
            threadId: thread.id,
          });
        }

        await expect(
          acceptThreadSendRequest(harness.deps, {
            payload: {
              input: textInput(`follow-up after ${operation}`),
              mode: "steer",
              model: "gpt-5",
              permissionMode: "full",
              reasoningLevel: "medium",
              serviceTier: "default",
            },
            thread,
          }),
        ).rejects.toMatchObject({
          body: {
            code: "thread_not_writable",
            details: { reason },
          },
          status: 409,
        });
        expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      });
    },
  );

  it("rejects a steer when the thread fails during startup admission", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedProviderThreadFixture({
        harness,
        status: "active",
        value: 67,
      });
      vi.spyOn(threadEvents, "getActiveTurnId").mockImplementationOnce(() => {
        applyLoggedThreadLifecycleEvent(harness.deps, {
          event: { type: "run.failed" },
          threadId: thread.id,
        });
        return null;
      });

      await expect(
        acceptThreadSendRequest(harness.deps, {
          payload: {
            input: textInput("do not strand this steer"),
            mode: "steer",
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          },
          thread,
        }),
      ).rejects.toMatchObject({
        body: {
          code: "thread_not_writable",
          details: { reason: "errored", threadStatus: "error" },
        },
        status: 409,
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    });
  });

  it("starts a turn when steer-if-active observes a startup failure", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedProviderThreadFixture({
        harness,
        status: "active",
        value: 68,
      });
      const input = textInput("recover this send as a new turn");
      vi.spyOn(threadEvents, "getActiveTurnId").mockImplementationOnce(() => {
        applyLoggedThreadLifecycleEvent(harness.deps, {
          event: { type: "run.failed" },
          threadId: thread.id,
        });
        return null;
      });

      await expect(
        acceptThreadSendRequest(harness.deps, {
          payload: {
            input,
            mode: "steer-if-active",
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          },
          thread,
        }),
      ).resolves.toEqual({ ok: true, delivery: "sent" });
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([
        expect.objectContaining({ input, target: { mode: "start" } }),
      ]);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    });
  });

  it("parks a steer until turn/started and then steers it into that turn", async () => {
    await withTestHarness(async (harness) => {
      const { sessionId, thread } = seedProviderThreadFixture({
        harness,
        status: "active",
        value: 6,
      });
      const input = textInput("steer when ready");
      const secondInput = textInput("also steer when ready");
      const queueChangedInTransactions: boolean[] = [];
      const notifyThread = harness.hub.notifyThread.bind(harness.hub);
      vi.spyOn(harness.hub, "notifyThread").mockImplementation(
        (threadId, changes, metadata) => {
          if (changes.includes("queue-changed")) {
            queueChangedInTransactions.push(harness.db.$client.inTransaction);
          }
          notifyThread(threadId, changes, metadata);
        },
      );

      await expect(
        acceptThreadSendRequest(harness.deps, {
          payload: {
            input,
            mode: "steer",
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          },
          thread,
        }),
      ).resolves.toMatchObject({
        delivery: "queued",
        queuedMessage: { waitingOn: { kind: "turn-starting" } },
      });
      await expect(
        acceptThreadSendRequest(harness.deps, {
          payload: {
            input: secondInput,
            mode: "auto",
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          },
          thread,
        }),
      ).resolves.toMatchObject({
        delivery: "queued",
        queuedMessage: { waitingOn: { kind: "turn-starting" } },
      });
      expect(queueChangedInTransactions).toEqual([false, false]);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toHaveLength(0);

      expect(
        listQueuedThreadMessages(harness.db, thread.id).map((row) => ({
          content: JSON.parse(row.content),
          waitingOn: JSON.parse(row.waitingOn!),
        })),
      ).toEqual([
        { content: input, waitingOn: { kind: "turn-starting" } },
        { content: secondInput, waitingOn: { kind: "turn-starting" } },
      ]);
      const busy = seedQueuedMessage(harness.deps, {
        content: textInput("wait for idle"),
        threadId: thread.id,
        waitingOn: { kind: "thread-busy" },
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId,
          eventGroups: groupHostDaemonEvents([
            {
              threadId: thread.id,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-send-dispatch-6",
                scope: turnScope("turn-ready"),
              },
            },
          ]),
        }),
      });
      expect(response.status).toBe(200);

      await vi.waitFor(() => {
        expect(
          listQueuedThreadCommands(harness, "turn.submit", thread.id),
        ).toHaveLength(2);
      });
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([
        expect.objectContaining({
          input,
          target: { mode: "auto", expectedTurnId: "turn-ready" },
        }),
        expect.objectContaining({
          input: secondInput,
          target: { mode: "auto", expectedTurnId: "turn-ready" },
        }),
      ]);
      expect(
        listQueuedThreadMessages(harness.db, thread.id).map((row) => row.id),
      ).toEqual([busy.id]);
      expect(
        JSON.parse(
          listQueuedThreadMessages(harness.db, thread.id)[0]!.waitingOn!,
        ),
      ).toEqual({ kind: "thread-busy" });

      vi.spyOn(threadEvents, "getActiveTurnId").mockReturnValueOnce(null);
      await expect(
        acceptThreadSendRequest(harness.deps, {
          payload: {
            input: textInput("send after the wake scan"),
            mode: "steer",
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          },
          thread,
        }),
      ).resolves.toEqual({ ok: true, delivery: "sent" });
    });
  });

  it("parks a parent system notice with its taxonomy while a turn starts", async () => {
    await withTestHarness(async (harness) => {
      const { sessionId, thread } = seedProviderThreadFixture({
        harness,
        status: "active",
        value: 62,
      });
      const input = textInput("child finished");

      await expect(
        queueParentSystemMessage(harness.deps, {
          input,
          parentThreadId: thread.id,
          systemMessageKind: "child-completed",
          systemMessageSubject: {
            kind: "thread",
            threadId: "child-1",
            threadName: "Child",
          },
        }),
      ).resolves.toBe(true);

      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toHaveLength(0);
      const parked = listQueuedThreadMessages(harness.db, thread.id)[0]!;
      expect(JSON.parse(parked.content)).toEqual(input);
      expect(JSON.parse(parked.waitingOn!)).toEqual({
        kind: "turn-starting",
      });
      expect(JSON.parse(parked.systemNotice!)).toEqual({
        kind: "child-completed",
        subject: {
          kind: "thread",
          threadId: "child-1",
          threadName: "Child",
        },
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId,
          eventGroups: groupHostDaemonEvents([
            {
              threadId: thread.id,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-send-dispatch-62",
                scope: turnScope("turn-system-notice-ready"),
              },
            },
          ]),
        }),
      });
      expect(response.status).toBe(200);

      await vi.waitFor(() => {
        expect(
          listQueuedThreadCommands(harness, "turn.submit", thread.id),
        ).toHaveLength(1);
      });
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([
        expect.objectContaining({
          input,
          target: {
            mode: "auto",
            expectedTurnId: "turn-system-notice-ready",
          },
        }),
      ]);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);

      vi.spyOn(threadEvents, "getActiveTurnId").mockReturnValueOnce(null);
      await expect(
        queueParentSystemMessage(harness.deps, {
          input,
          parentThreadId: thread.id,
          systemMessageKind: "child-completed",
          systemMessageSubject: {
            kind: "thread",
            threadId: "child-2",
            threadName: "Other child",
          },
        }),
      ).resolves.toBe(true);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toHaveLength(2);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id)[1],
      ).toMatchObject({
        target: { mode: "auto", expectedTurnId: "turn-system-notice-ready" },
      });
    });
  });

  it("sends every message an answered interaction held, in order, into the running turn (#851), flagging an outdated report (#1208)", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedProviderThreadFixture({
        harness,
        status: "active",
        value: 851,
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-send-dispatch-851",
        threadId: thread.id,
        turnId: "turn-851",
      });
      const child = seedThread(harness.deps, {
        projectId: thread.projectId,
        parentThreadId: thread.id,
      });
      const interaction = createPendingInteraction(harness.db, {
        originKind: "plugin",
        pluginId: "plugin-851",
        rendererId: "renderer-851",
        threadId: thread.id,
        turnId: null,
        payload: JSON.stringify({ kind: "plugin", title: "Approve" }),
      });
      for (const text of ["progress 1", "progress 2"]) {
        await acceptThreadSendRequest(harness.deps, {
          payload: {
            input: textInput(text),
            mode: "steer-if-active",
            senderThreadId: child.id,
          },
          thread,
        });
      }
      // The child writes newer output after its report, before it queues (#1208).
      seedStoredEvent(harness.deps, {
        threadId: child.id,
        providerThreadId: "provider-child-851",
        scope: turnScope("turn-child-851"),
        sequence: 1,
        type: "item/completed",
        itemKind: "agentMessage",
        data: { item: { type: "agentMessage", id: "msg-851", text: "newer" } },
      });
      await queueParentSystemMessage(harness.deps, {
        childReport: { at: Date.now(), sequences: { [child.id]: 0 } },
        input: buildChildThreadTurnStatusBatchInput({
          items: [
            {
              activeWorkflowCount: 0,
              childThread: child,
              terminalOutput: "child completed",
              turnStatus: "completed",
            },
          ],
        }),
        parentThreadId: thread.id,
        systemMessageKind: "child-completed",
        systemMessageSubject: null,
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(3);

      setPendingInteractionResolved(harness.db, {
        id: interaction.id,
        resolution: "{}",
      });
      await runQueuedMessageDispatch(harness.deps, {
        kind: "interaction-settled",
        threadId: thread.id,
      });

      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      const sent = listQueuedThreadCommands(harness, "turn.submit", thread.id);
      expect(
        sent.map((command) =>
          command.type === "turn.submit" ? command.target : null,
        ),
      ).toEqual(Array(3).fill({ mode: "auto", expectedTurnId: "turn-851" }));
      expect(JSON.stringify(sent[0])).toContain("progress 1");
      expect(JSON.stringify(sent[1])).toContain("progress 2");
      expect(JSON.stringify(sent[2])).toContain("child completed");
      expect(JSON.stringify(sent[2])).toContain(
        `\\n\\nThis child has newer output: room-cli thread output ${child.id}`,
      );
    });
  });

  it("does not queue a parent notice when archive wins during preparation", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedProviderThreadFixture({
        harness,
        status: "active",
        value: 65,
      });

      const delivered = queueParentSystemMessage(harness.deps, {
        input: textInput("child finished after archive"),
        parentThreadId: thread.id,
        systemMessageKind: "child-completed",
        systemMessageSubject: null,
      });
      archiveThread(harness.db, harness.hub, thread.id);

      await expect(delivered).resolves.toBe(false);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    });
  });

  it("a queued child report joins the turn another message started while it prepared, instead of failing (#1341)", async () => {
    await withTestHarness(async (harness) => {
      const capture = installTelemetryCaptureSpy(harness);
      const { thread } = seedProviderThreadFixture({ harness, value: 1341 });
      createQueuedThreadMessage(harness.db, harness.deps.hub, {
        threadId: thread.id,
        content: textInput("child A completed"),
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "auto",
        serviceTier: "default",
        senderThreadId: null,
        waitingOn: { kind: "thread-busy" },
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: { kind: "child-completed", subject: null },
      });

      const preparation = holdFirstPreparation();
      const drain = runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });
      await preparation.reached;
      await queueParentSystemMessage(harness.deps, {
        input: textInput("child B completed"),
        parentThreadId: thread.id,
        systemMessageKind: "child-completed",
        systemMessageSubject: null,
      });
      preparation.release();
      await drain;

      // Child B started the turn. Child A waits for it to start, then joins it.
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
      expect(
        listQueuedThreadMessages(harness.db, thread.id).map((row) => ({
          content: JSON.parse(row.content),
          failureReason: row.failureReason,
          waitingOn: JSON.parse(row.waitingOn!),
        })),
      ).toEqual([
        {
          content: textInput("child A completed"),
          failureReason: null,
          waitingOn: { kind: "turn-starting" },
        },
      ]);
      expect(capture).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: "queue_delivery" }),
      );
    });
  });

  it("keeps a child report when the parent's turn ends while it prepares (#1341)", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedProviderThreadFixture({
        harness,
        status: "active",
        value: 1342,
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-send-dispatch-1342",
        threadId: thread.id,
        turnId: "turn-1342",
      });

      const preparation = holdFirstPreparation();
      const delivered = queueParentSystemMessage(harness.deps, {
        input: textInput("child finished as the turn ended"),
        parentThreadId: thread.id,
        systemMessageKind: "child-completed",
        systemMessageSubject: null,
      });
      await preparation.reached;
      applyLoggedThreadLifecycleEvent(harness.deps, {
        threadId: thread.id,
        event: { type: "run.succeeded" },
      });
      preparation.release();

      // The report starts the next turn. Before, it was dropped without a trace.
      await expect(delivered).resolves.toBe(true);
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([expect.objectContaining({ target: { mode: "start" } })]);
    });
  });
});

describe("turn submit failure settlement", () => {
  it.each([
    {
      errorCode: "provider_rpc_error",
      errorMessage: "No active turn to steer",
      message: "No active turn to steer",
    },
    // A signed-out Grok's auth failure gains its sign-in hint (#1160).
    {
      providerId: "acp-grok",
      errorCode: "auth_required",
      errorMessage: "Authentication required: no auth method id provided",
      message:
        "Authentication required: no auth method id provided. Run `grok login` on the machine to sign in.",
    },
    // Fast mode discovers models first, which fails typed.
    {
      providerId: "acp-grok",
      errorCode: "auth_required",
      errorMessage: "ACP agent is not authenticated.",
      message:
        "ACP agent is not authenticated. Run `grok login` on the machine to sign in.",
    },
    // Cursor keeps its own auth text.
    {
      providerId: "acp-cursor",
      errorCode: "auth_required",
      errorMessage: "Authentication required: run cursor-agent login",
      message: "Authentication required: run cursor-agent login",
    },
  ])("records a terminal rejection for the failed client request ($providerId $errorCode)", async (failure) => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedProviderThreadFixture({
        harness,
        status: "active",
        value: 7,
        ...(failure.providerId === undefined
          ? {}
          : { providerId: failure.providerId }),
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-send-dispatch-7",
        sequence: 3,
        threadId: thread.id,
        turnId: "turn-active",
      });
      const activeThread = getThread(harness.db, thread.id);
      if (!activeThread) throw new Error("Expected an active thread");

      await sendThreadMessage(harness.deps, {
        environment,
        payload: {
          input: textInput("failed steer"),
          mode: "steer",
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        thread: activeThread,
        trigger: "user",
      });
      const queued = await waitForQueuedCommand(
        harness,
        (candidate) =>
          candidate.command.type === "turn.submit" &&
          candidate.command.threadId === thread.id,
      );
      if (queued.command.type !== "turn.submit") {
        throw new Error("Expected a turn.submit command");
      }
      await reportQueuedCommandError(harness, queued, {
        errorCode: failure.errorCode,
        errorMessage: failure.errorMessage,
      });

      const rejection = listEvents(harness.db, {
        threadId: thread.id,
      }).find((event) => event.type === "client/turn/rejected");
      expect(rejection).toBeDefined();
      expect(JSON.parse(rejection?.data ?? "{}")).toEqual({
        requestId: queued.command.requestId,
        reason: failure.errorCode,
        message: failure.message,
      });
    });
  });

  it("records a rejection after the target turn completes", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedProviderThreadFixture({
        harness,
        status: "active",
        value: 8,
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-send-dispatch-8",
        sequence: 3,
        threadId: thread.id,
        turnId: "turn-active",
      });
      const activeThread = getThread(harness.db, thread.id);
      if (!activeThread) throw new Error("Expected an active thread");

      await sendThreadMessage(harness.deps, {
        environment,
        payload: {
          input: textInput("late failed steer"),
          mode: "steer",
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        thread: activeThread,
        trigger: "user",
      });
      const queued = await waitForQueuedCommand(
        harness,
        (candidate) =>
          candidate.command.type === "turn.submit" &&
          candidate.command.threadId === thread.id,
      );
      if (
        queued.command.type !== "turn.submit" ||
        queued.command.target.mode === "start" ||
        queued.command.target.expectedTurnId === null
      ) {
        throw new Error("Expected a turn.submit command with a target turn");
      }
      seedStoredEvent(harness.deps, {
        data: { status: "completed" },
        environmentId: environment.id,
        providerThreadId: "provider-send-dispatch-8",
        scope: turnScope(queued.command.target.expectedTurnId),
        sequence: 100,
        threadId: thread.id,
        type: "turn/completed",
      });
      await reportQueuedCommandError(harness, queued, {
        errorCode: "provider_rpc_error",
        errorMessage: "No active turn to steer",
      });

      const eventTypes = listEvents(harness.db, {
        threadId: thread.id,
      }).map((event) => event.type);
      expect(eventTypes).toContain("client/turn/rejected");
    });
  });

  it("does not reject an accepted client request", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedProviderThreadFixture({
        harness,
        status: "active",
        value: 9,
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-send-dispatch-9",
        sequence: 3,
        threadId: thread.id,
        turnId: "turn-active",
      });
      const activeThread = getThread(harness.db, thread.id);
      if (!activeThread) throw new Error("Expected an active thread");

      await sendThreadMessage(harness.deps, {
        environment,
        payload: {
          input: textInput("accepted steer"),
          mode: "steer",
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        thread: activeThread,
        trigger: "user",
      });
      const queued = await waitForQueuedCommand(
        harness,
        (candidate) =>
          candidate.command.type === "turn.submit" &&
          candidate.command.threadId === thread.id,
      );
      if (queued.command.type !== "turn.submit") {
        throw new Error("Expected a turn.submit command");
      }
      seedStoredEvent(harness.deps, {
        data: { clientRequestId: queued.command.requestId },
        environmentId: environment.id,
        providerThreadId: "provider-send-dispatch-9",
        scope: turnScope("turn-active"),
        sequence: 100,
        threadId: thread.id,
        type: "turn/input/accepted",
      });

      await reportQueuedCommandError(harness, queued, {
        errorCode: "provider_rpc_error",
        errorMessage: "Response arrived after acceptance",
      });

      const eventTypes = listEvents(harness.db, {
        threadId: thread.id,
      }).map((event) => event.type);
      expect(eventTypes).not.toContain("client/turn/rejected");
      expect(eventTypes).not.toContain("system/error");
    });
  });
});

describe("idle cold-start activation", () => {
  it("activates an idle thread immediately when it does a cold thread.start", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedColdIdleThreadFixture({
        harness,
        value: 3,
      });

      await sendThreadMessage(harness.deps, {
        environment,
        payload: {
          input: textInput("cold start from idle"),
          mode: "start",
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        thread,
        trigger: "user",
      });

      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "active",
      });
      await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "thread.start" &&
          queued.command.threadId === thread.id,
      );
      expect(
        listQueuedThreadCommands(harness, "thread.start", thread.id),
      ).toHaveLength(1);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toHaveLength(0);
    });
  });

  it("resumes provider continuity after an environment directory update", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedProviderThreadFixture({
        harness,
        value: 4,
      });
      const targetEnvironment = seedEnvironment(harness.deps, {
        hostId: environment.hostId,
        projectId: environment.projectId,
        path: "/tmp/send-dispatch-switched",
        status: "ready",
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-send-dispatch-4",
        sequence: 3,
        threadId: thread.id,
        turnId: "turn_before_switch",
      });
      const updateResult = await handleUpdateEnvironmentDirectoryToolCall(
        harness.deps,
        {
          currentEnvironment: environment,
          input: { path: targetEnvironment.path },
          thread,
          turnId: "turn_before_switch",
        },
      );
      expect(updateResult).toMatchObject({ success: true });
      expect(getThread(harness.db, thread.id)).toMatchObject({
        environmentId: targetEnvironment.id,
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        environmentId: targetEnvironment.id,
        providerThreadId: `provider-send-dispatch-4`,
        sequence: 5,
        type: "turn/completed",
        scope: turnScope("turn_after_switch"),
        data: {
          providerThreadId: `provider-send-dispatch-4`,
          status: "completed",
        },
      });
      const switchedThread = getThread(harness.db, thread.id);
      if (!switchedThread) {
        throw new Error("Expected switched thread to exist");
      }

      await sendThreadMessage(harness.deps, {
        environment: targetEnvironment,
        payload: {
          input: textInput("start after switch"),
          mode: "start",
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        thread: switchedThread,
        trigger: "user",
      });

      await waitForQueuedCommand(
        harness,
        (queued) =>
          queued.command.type === "turn.submit" &&
          queued.command.threadId === thread.id,
      );
      const turnSubmitCommands = listQueuedThreadCommands(
        harness,
        "turn.submit",
        thread.id,
      );
      expect(turnSubmitCommands).toHaveLength(1);
      expect(turnSubmitCommands[0]).toMatchObject({
        type: "turn.submit",
        environmentId: targetEnvironment.id,
        resumeContext: {
          providerThreadId: "provider-send-dispatch-4",
          workspaceContext: {
            workspacePath: targetEnvironment.path,
          },
        },
      });
      expect(
        listQueuedThreadCommands(harness, "thread.start", thread.id),
      ).toHaveLength(0);
    });
  });
});

describe("service tier execution lifecycle", () => {
  it.each(["fast", "default"] as const)(
    "uses an accepted direct %s choice as the next default",
    async (serviceTier) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedProviderThreadFixture({
          harness,
          value: 80,
          serviceTier: serviceTier === "fast" ? "default" : "fast",
        });
        await expect(
          acceptThreadSendRequest(harness.deps, {
            thread,
            payload: {
              input: textInput("change tier"),
              mode: "start",
              serviceTier,
            },
          }),
        ).resolves.toMatchObject({ delivery: "sent" });
        expect(
          threadEvents.getLastExecutionOptions(harness.deps, thread.id),
        ).toMatchObject({ serviceTier });
        await expect(
          buildExecutionOptions(harness.deps, {}, { threadId: thread.id }),
        ).resolves.toMatchObject({ serviceTier });
        expect(
          listQueuedThreadCommands(harness, "turn.submit", thread.id),
        ).toContainEqual(
          expect.objectContaining({
            options: expect.objectContaining({ serviceTier }),
          }),
        );
      });
    },
  );

  it("keeps queued choices separate until dispatch and preserves the next row", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedProviderThreadFixture({
        harness,
        value: 81,
        status: "active",
        serviceTier: "fast",
      });
      const older = await createQueuedMessageForThread(harness.deps, {
        thread,
        payload: {
          input: textInput("older standard turn"),
          serviceTier: "default",
        },
      });
      const newer = await createQueuedMessageForThread(harness.deps, {
        thread,
        payload: { input: textInput("newer fast turn"), serviceTier: "fast" },
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toMatchObject([
        { id: older.id, serviceTier: "default" },
        { id: newer.id, serviceTier: "fast" },
      ]);
      await expect(
        buildExecutionOptions(harness.deps, {}, { threadId: thread.id }),
      ).resolves.toMatchObject({ serviceTier: "fast" });
      applyLoggedThreadLifecycleEvent(harness.deps, {
        event: { type: "run.succeeded" },
        threadId: thread.id,
      });
      await sendNextQueuedMessageIfPresent(harness.deps, {
        threadId: thread.id,
      });
      expect(
        threadEvents.getLastExecutionOptions(harness.deps, thread.id),
      ).toMatchObject({ serviceTier: "default" });
      await expect(
        buildExecutionOptions(harness.deps, {}, { threadId: thread.id }),
      ).resolves.toMatchObject({ serviceTier: "default" });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toMatchObject([
        { id: newer.id, serviceTier: "fast" },
      ]);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toContainEqual(
        expect.objectContaining({
          options: expect.objectContaining({ serviceTier: "default" }),
        }),
      );
    });
  });

  it("snapshots a busy follow-up without changing the active tier", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedProviderThreadFixture({
        harness,
        value: 83,
        status: "active",
        serviceTier: "fast",
      });
      const result = await acceptThreadSendRequest(harness.deps, {
        thread,
        payload: {
          input: textInput("wait for standard"),
          mode: "queue-if-active",
          serviceTier: "default",
        },
      });
      expect(result).toMatchObject({
        delivery: "queued",
        queuedMessage: { serviceTier: "default" },
      });
      expect(
        threadEvents.getLastExecutionOptions(harness.deps, thread.id),
      ).toMatchObject({ serviceTier: "fast" });
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([]);
    });
  });

  it("does not save a rejected default choice or consume its queued snapshot", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedProviderThreadFixture({
        harness,
        value: 82,
        serviceTier: "fast",
      });
      const queued = await createQueuedMessageForThread(harness.deps, {
        thread,
        payload: { input: textInput("standard turn"), serviceTier: "default" },
      });
      archiveThread(harness.db, harness.hub, thread.id);
      await expect(
        acceptThreadSendRequest(harness.deps, {
          thread,
          payload: {
            input: textInput("rejected"),
            mode: "start",
            serviceTier: "default",
          },
        }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        sendQueuedMessageNow(harness.deps, {
          threadId: thread.id,
          queuedMessageId: queued.id,
          mode: "auto",
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        threadEvents.getLastExecutionOptions(harness.deps, thread.id),
      ).toMatchObject({ serviceTier: "fast" });
      expect(getQueuedThreadMessage(harness.db, queued.id)).toMatchObject({
        serviceTier: "default",
      });
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([]);
    });
  });
});

describe("concurrent idle dispatch regression", () => {
  it("retains every concurrent queue-mode send", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedProviderThreadFixture({
        harness,
        value: 3716,
      });
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, (_, index) =>
          acceptThreadSendRequest(harness.deps, {
            thread,
            payload: {
              input: textInput(`concurrent message ${index}`),
              mode: "queue-if-active",
              model: "gpt-5",
              permissionMode: "full",
              reasoningLevel: "medium",
              serviceTier: "default",
            },
          }),
        ),
      );
      expect(
        results.map((result) =>
          result.status === "rejected" ? String(result.reason) : result.status,
        ),
        `queued=${listQueuedThreadMessages(harness.db, thread.id).length}; commands=${listQueuedThreadCommands(harness, "turn.submit", thread.id).length}`,
      ).toEqual(Array.from({ length: 4 }, () => "fulfilled"));
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(3);

      seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("scheduled concurrent message"),
        waitingOn: { kind: "time" },
        sendAt: Date.now() - 1,
      });
      applyLoggedThreadLifecycleEvent(harness.deps, {
        event: { type: "run.succeeded" },
        threadId: thread.id,
      });
      // The idle drain and a scheduled wake may both claim work before either sends.
      await Promise.all([
        sendNextQueuedMessageIfPresent(harness.deps, { threadId: thread.id }),
        runQueuedMessageDispatch(harness.deps, {
          kind: "time-reached",
          now: Date.now(),
        }),
      ]);
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: threadEvents.getLastProviderThreadId(
          harness.deps,
          thread.id,
        )!,
        threadId: thread.id,
        turnId: "concurrent-drain-turn",
      });
      await runQueuedMessageDispatch(harness.deps, {
        kind: "turn-started",
        threadId: thread.id,
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(3);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toHaveLength(2);
    });
  });
});
