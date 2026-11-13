import { eq, sql } from "drizzle-orm";
import {
  createQueuedThreadMessage,
  events,
  getLatestThreadSequence,
  getThread,
  listEvents,
  listQueuedThreadMessages,
} from "@cloudroom/db";
import { threadScope, turnScope } from "@cloudroom/domain";
import {
  groupHostDaemonEvents,
  hostDaemonEventBatchResponseSchema,
  type HostDaemonEventEnvelope,
} from "@cloudroom/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { buildThreadTimelineWithProfile } from "../../src/services/threads/timeline.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import {
  internalAuthHeaders,
  listQueuedThreadCommands,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  createCommandApprovalPayload,
  createUserQuestionPayload,
} from "../helpers/pending-interactions.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";

interface SeedEventRouteArgs {}

interface PostEventBatchArgs {
  harness: TestAppHarness;
  sessionId: string;
  events: HostDaemonEventEnvelope[];
}

async function postEventBatch(args: PostEventBatchArgs): Promise<Response> {
  return args.harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(args.harness),
    body: JSON.stringify({
      sessionId: args.sessionId,
      eventGroups: groupHostDaemonEvents(args.events),
    }),
  });
}

async function sweepAfterGrace(harness: TestAppHarness, threadId: string) {
  harness.db
    .update(events)
    .set({ createdAt: sql`${events.createdAt} - 31000` })
    .where(eq(events.threadId, threadId))
    .run();
  await runQueuedMessageDispatch(harness.deps, {
    kind: "idle-recovery",
    now: Date.now(),
  });
}

function setupEventRoute(args: SeedEventRouteArgs = {}) {
  return createTestAppHarness().then((harness) => {
    const { host, session } = seedHostSession(harness.deps);
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
      status: "active",
    });
    return {
      environment,
      harness,
      host,
      project,
      session,
      thread,
    };
  });
}

describe("internal event append ownership", () => {
  it("keeps late provisioning output terminal after setup has failed", async () => {
    const { environment, harness, session, thread } = await setupEventRoute();
    try {
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "system/thread-provisioning",
        scope: threadScope(),
        data: {
          provisioningId: "tpv-terminal",
          environmentId: environment.id,
          status: "failed",
          entries: [],
        },
      });

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "system/thread-provisioning",
              threadId: thread.id,
              scope: threadScope(),
              provisioningId: "tpv-terminal",
              environmentId: environment.id,
              status: "active",
              entries: [
                {
                  type: "output",
                  key: "setup-output",
                  text: "late buffered setup output",
                },
              ],
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(
        listEvents(harness.db, { threadId: thread.id }).map((row) =>
          JSON.parse(row.data),
        ),
      ).toMatchObject([
        { status: "failed" },
        {
          status: "failed",
          entries: [{ text: "late buffered setup output" }],
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("stores thread-scoped ACP context usage for the timeline display", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "thread/contextWindowUsage/updated",
              threadId: thread.id,
              providerThreadId: "acp-session-1",
              scope: threadScope(),
              contextWindowUsage: {
                usedTokens: 24_000,
                modelContextWindow: 128_000,
                estimated: false,
              },
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(
        buildThreadTimelineWithProfile(harness.db, thread, {
          completedTurnDisplay: "collapse",
          eventBudget: 1_000_000,
          includeDiagnosticOperations: true,
          maxInlineOutputChars: null,
          maxSeq: 1,
          page: {
            kind: "latest",
            segmentLimit: Number.MAX_SAFE_INTEGER,
          },
        }).response.contextWindowUsage,
      ).toEqual({
        usedTokens: 24_000,
        modelContextWindow: 128_000,
        estimated: false,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("assigns server-owned sequences and returns accepted event indexes", async () => {
    const { environment, harness, session, thread } = await setupEventRoute();
    try {
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 3,
        type: "system/error",
        scope: threadScope(),
        data: { message: "existing" },
      });

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "system/error",
              threadId: thread.id,
              scope: threadScope(),
              message: "first daemon",
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "system/error",
              threadId: thread.id,
              scope: threadScope(),
              message: "second daemon",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        acceptedEvents: [
          {
            eventIndex: 0,
            threadId: thread.id,
            sequence: 4,
          },
          {
            eventIndex: 1,
            threadId: thread.id,
            sequence: 5,
          },
        ],
        rejectedEvents: [],
      });
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toMatchObject([
        { sequence: 3 },
        {
          sequence: 4,
        },
        {
          sequence: 5,
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns original event indexes after dropping orphan turn snapshots", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "thread/tokenUsage/updated",
              threadId: thread.id,
              scope: turnScope("turn-from-source-thread"),
              providerThreadId: "provider-fork-session",
              tokenUsage: {
                total: {
                  totalTokens: 42,
                  inputTokens: 20,
                  cachedInputTokens: 5,
                  outputTokens: 12,
                  reasoningOutputTokens: 5,
                },
                last: {
                  totalTokens: 42,
                  inputTokens: 20,
                  cachedInputTokens: 5,
                  outputTokens: 12,
                  reasoningOutputTokens: 5,
                },
                modelContextWindow: 200_000,
              },
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "system/error",
              threadId: thread.id,
              scope: threadScope(),
              message: "accepted after skipped",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        acceptedEvents: [
          {
            eventIndex: 1,
            threadId: thread.id,
            sequence: 1,
          },
        ],
        rejectedEvents: [],
      });
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toMatchObject([
        {
          sequence: 1,
          type: "system/error",
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("accepts a batch carrying a provider/unhandled event for a turn bb never started", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "provider/unhandled",
              threadId: thread.id,
              providerThreadId: "provider-compacting-session",
              providerId: "codex",
              rawType: "sdk/custom",
              scope: turnScope("auto-compact-1"),
              rawEvent: {
                jsonrpc: "2.0",
                method: "sdk/message",
                params: { threadId: thread.id, turnId: "auto-compact-1" },
              },
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "system/error",
              threadId: thread.id,
              scope: threadScope(),
              message: "queued behind the orphan event",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        acceptedEvents: [
          {
            eventIndex: 1,
            threadId: thread.id,
            sequence: 1,
          },
        ],
        rejectedEvents: [],
      });
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toMatchObject([
        {
          sequence: 1,
          type: "system/error",
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("assigns distinct sequences for simultaneous requests on the same thread", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      const [firstResponse, secondResponse] = await Promise.all([
        postEventBatch({
          harness,
          sessionId: session.id,
          events: [
            {
              threadId: thread.id,
              event: {
                type: "system/error",
                threadId: thread.id,
                scope: threadScope(),
                message: "first simultaneous daemon",
              },
            },
          ],
        }),
        postEventBatch({
          harness,
          sessionId: session.id,
          events: [
            {
              threadId: thread.id,
              event: {
                type: "system/error",
                threadId: thread.id,
                scope: threadScope(),
                message: "second simultaneous daemon",
              },
            },
          ],
        }),
      ]);

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      const firstBody = hostDaemonEventBatchResponseSchema.parse(
        await readJson(firstResponse),
      );
      const secondBody = hostDaemonEventBatchResponseSchema.parse(
        await readJson(secondResponse),
      );
      expect(
        [...firstBody.acceptedEvents, ...secondBody.acceptedEvents]
          .map((event) => event.sequence)
          .sort((left, right) => left - right),
      ).toEqual([1, 2]);

      const storedRows = harness.db
        .select({
          sequence: events.sequence,
        })
        .from(events)
        .where(eq(events.threadId, thread.id))
        .all();

      expect(storedRows).toHaveLength(2);
      expect(
        storedRows
          .map((row) => row.sequence)
          .sort((left, right) => left - right),
      ).toEqual([1, 2]);
    } finally {
      await harness.cleanup();
    }
  });

  it("auto-sends a queued message after a zero-work turn completes", async () => {
    const { environment, harness, session, thread } = await setupEventRoute();
    try {
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        inputText: "/clear",
        providerThreadId: "provider-zero-work",
        threadId: thread.id,
      });
      seedQueuedMessage(harness.deps, {
        content: [
          {
            type: "text",
            text: "queued behind zero-work turn",
            mentions: [],
          },
        ],
        threadId: thread.id,
      });

      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "turn/started",
              threadId: thread.id,
              providerThreadId: "provider-zero-work",
              scope: turnScope("turn-zero-work"),
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "turn/completed",
              threadId: thread.id,
              providerThreadId: "provider-zero-work",
              scope: turnScope("turn-zero-work"),
              status: "completed",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      const queuedTurn = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(queuedTurn.command).toMatchObject({
        type: "turn.submit",
        input: [
          {
            type: "text",
            text: "queued behind zero-work turn",
            mentions: [],
          },
        ],
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
    } finally {
      await harness.cleanup();
    }
  });

  it.each([
    { status: "failed" as const, error: { message: "Provider error" } },
    { status: "interrupted" as const },
  ])(
    "auto-sends a message queued behind a turn that ends $status on its own",
    async (completion) => {
      const { environment, harness, session, thread } = await setupEventRoute();
      try {
        seedThreadRuntimeState(harness.deps, {
          environmentId: environment.id,
          providerThreadId: "provider-ends-alone",
          threadId: thread.id,
        });
        seedQueuedMessage(harness.deps, {
          content: [{ type: "text", text: "queued fix", mentions: [] }],
          threadId: thread.id,
          waitingOn: { kind: "thread-busy" },
        });
        seedQueuedMessage(harness.deps, {
          content: [{ type: "text", text: "queued later", mentions: [] }],
          threadId: thread.id,
          waitingOn: null,
        });
        const completed: HostDaemonEventEnvelope = {
          threadId: thread.id,
          event: {
            type: "turn/completed",
            threadId: thread.id,
            providerThreadId: "provider-ends-alone",
            scope: turnScope("turn-ends-alone"),
            ...completion,
          },
        };

        const response = await postEventBatch({
          harness,
          sessionId: session.id,
          events: [
            {
              threadId: thread.id,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-ends-alone",
                scope: turnScope("turn-ends-alone"),
              },
            },
            completed,
          ],
        });

        expect(response.status).toBe(200);
        if (completion.status === "failed") {
          await sweepAfterGrace(harness, thread.id);
        }
        const queuedTurn = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "turn.submit" && command.threadId === thread.id,
        );
        expect(queuedTurn.command).toMatchObject({
          input: [{ type: "text", text: "queued fix", mentions: [] }],
        });

        const replay = await postEventBatch({
          harness,
          sessionId: session.id,
          events: [completed],
        });
        expect(replay.status).toBe(200);
        await runQueuedMessageDispatch(harness.deps, {
          kind: "idle-recovery",
          now: Date.now(),
        });
        expect(
          listQueuedThreadCommands(harness, "turn.submit", thread.id),
        ).toHaveLength(1);
        expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);

        const nextFailed = await postEventBatch({
          harness,
          sessionId: session.id,
          events: [
            {
              threadId: thread.id,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-ends-alone",
                scope: turnScope("turn-queued-fix"),
              },
            },
            {
              threadId: thread.id,
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId: "provider-ends-alone",
                scope: turnScope("turn-queued-fix"),
                status: "failed",
                error: { message: "Again" },
              },
            },
          ],
        });
        expect(nextFailed.status).toBe(200);
        await sweepAfterGrace(harness, thread.id);
        expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(
          completion.status === "failed" ? 1 : 0,
        );
      } finally {
        await harness.cleanup();
      }
    },
  );

  it.each([
    { status: "failed" as const, error: { message: "Provider error" } },
    { status: "interrupted" as const },
  ])(
    "holds a message queued during Stop until the stop lands ($status)",
    async (completion) => {
      const { environment, harness, session, thread } = await setupEventRoute();
      try {
        seedThreadRuntimeState(harness.deps, {
          environmentId: environment.id,
          providerThreadId: "provider-stop-fail",
          threadId: thread.id,
        });
        const started = await postEventBatch({
          harness,
          sessionId: session.id,
          events: [
            {
              threadId: thread.id,
              event: {
                type: "turn/started",
                threadId: thread.id,
                providerThreadId: "provider-stop-fail",
                scope: turnScope("turn-stop-fail"),
              },
            },
          ],
        });
        expect(started.status).toBe(200);
        const stopResponse = harness.app.request(
          `/api/v1/threads/${thread.id}/stop`,
          { method: "POST" },
        );
        const stop = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.stop" && command.threadId === thread.id,
        );
        const queued = await harness.app.request(
          `/api/v1/threads/${thread.id}/queued-messages`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              input: [{ type: "text", text: "after stop" }],
              model: "gpt-5",
              permissionMode: "full",
              reasoningLevel: "medium",
              serviceTier: "default",
            }),
          },
        );
        expect(queued.status).toBe(201);
        const failed = await postEventBatch({
          harness,
          sessionId: session.id,
          events: [
            {
              threadId: thread.id,
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId: "provider-stop-fail",
                scope: turnScope("turn-stop-fail"),
                ...completion,
              },
            },
          ],
        });
        expect(failed.status).toBe(200);
        await runQueuedMessageDispatch(harness.deps, {
          kind: "idle-recovery",
          now: Date.now(),
        });
        expect(
          listQueuedThreadCommands(harness, "turn.submit", thread.id),
        ).toEqual([]);

        await reportQueuedCommandSuccess(harness, stop, {
          providerCheckpointId: null,
        });
        expect((await stopResponse).status).toBe(200);
        await sweepAfterGrace(harness, thread.id);
        expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      } finally {
        await harness.cleanup();
      }
    },
  );

  it.each([
    { mark: "$.queueDelivered", value: "true" },
    { mark: "$.initiator", value: '"system"' },
  ])("holds the queue after an automatic run ($mark) fails too, until the user sends again", async (automatic) => {
    const { environment, harness, session, thread } = await setupEventRoute();
    try {
      const failRun = async (
        sequenceStart: number,
        turnId: string,
        isAutomatic: boolean,
      ) => {
        seedThreadRuntimeState(harness.deps, {
          environmentId: environment.id,
          providerThreadId: "provider-failed-twice",
          sequenceStart,
          threadId: thread.id,
        });
        if (isAutomatic) {
          harness.db
            .update(events)
            .set({
              data: sql`json_set(${events.data}, ${automatic.mark}, json(${automatic.value}))`,
            })
            .where(eq(events.sequence, sequenceStart + 1))
            .run();
        }
        const failed = await postEventBatch({
          harness,
          sessionId: session.id,
          events: ["turn/started", "turn/completed"].map((type) => ({
            threadId: thread.id,
            event:
              type === "turn/started"
                ? {
                    type: "turn/started" as const,
                    threadId: thread.id,
                    providerThreadId: "provider-failed-twice",
                    scope: turnScope(turnId),
                  }
                : {
                    type: "turn/completed" as const,
                    threadId: thread.id,
                    providerThreadId: "provider-failed-twice",
                    scope: turnScope(turnId),
                    status: "failed" as const,
                    error: { message: "Provider still broken" },
                  },
          })),
        });
        expect(failed.status).toBe(200);
      };
      await failRun(1, "turn-user-fails", false);
      await failRun(5, "turn-queued-fails", true);
      for (const text of ["queued C", "queued E"]) {
        seedQueuedMessage(harness.deps, {
          content: [{ type: "text", text, mentions: [] }],
          threadId: thread.id,
          waitingOn: { kind: "thread-busy" },
        });
      }
      await sweepAfterGrace(harness, thread.id);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([]);

      await failRun(9, "turn-user-sends-again", false);
      await sweepAfterGrace(harness, thread.id);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toHaveLength(1);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps queued messages behind a scheduled retry of the failed turn", async () => {
    const { environment, harness, session, thread } = await setupEventRoute();
    try {
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-retry-first",
        threadId: thread.id,
      });
      seedQueuedMessage(harness.deps, {
        content: [{ type: "text", text: "queued B", mentions: [] }],
        threadId: thread.id,
        waitingOn: { kind: "thread-busy" },
      });
      const failed = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "turn/started",
              threadId: thread.id,
              providerThreadId: "provider-retry-first",
              scope: turnScope("turn-retry-first"),
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "turn/completed",
              threadId: thread.id,
              providerThreadId: "provider-retry-first",
              scope: turnScope("turn-retry-first"),
              status: "failed",
              error: { message: "Overloaded" },
            },
          },
        ],
      });
      expect(failed.status).toBe(200);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now(),
      });
      createQueuedThreadMessage(harness.db, harness.deps.hub, {
        threadId: thread.id,
        content: [{ type: "text", text: "retry A", mentions: [] }],
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        senderThreadId: null,
        waitingOn: { kind: "time" },
        sendAt: Date.now() + 60 * 60_000,
        payload: {
          kind: "retry",
          retryOfTurnRequestId: "creq_retryfirst",
          attempt: 2,
          reason: "Rate limited",
        },
        systemNotice: null,
      });
      await sweepAfterGrace(harness, thread.id);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([]);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("pauses the queue of a thread in error when the user stops it", async () => {
    const { environment, harness, session, thread } = await setupEventRoute();
    try {
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-error-stop",
        threadId: thread.id,
      });
      const failed = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "turn/started",
              threadId: thread.id,
              providerThreadId: "provider-error-stop",
              scope: turnScope("turn-error-stop"),
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "turn/completed",
              threadId: thread.id,
              providerThreadId: "provider-error-stop",
              scope: turnScope("turn-error-stop"),
              status: "failed",
              error: { message: "Provider error" },
            },
          },
        ],
      });
      expect(failed.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.status).toBe("error");
      seedQueuedMessage(harness.deps, {
        content: [{ type: "text", text: "held by stop", mentions: [] }],
        threadId: thread.id,
        waitingOn: { kind: "thread-busy" },
      });

      const stopResponse = harness.app.request(
        `/api/v1/threads/${thread.id}/stop`,
        { method: "POST" },
      );
      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      await reportQueuedCommandSuccess(harness, stop, {
        providerCheckpointId: null,
      });
      expect((await stopResponse).status).toBe(200);
      await sweepAfterGrace(harness, thread.id);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([]);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects unowned thread events without blocking owned events in the same batch", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: "thr_missing",
            event: {
              type: "system/error",
              threadId: "thr_missing",
              scope: threadScope(),
              message: "stale daemon event",
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "system/error",
              threadId: thread.id,
              scope: threadScope(),
              message: "owned daemon event",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        acceptedEvents: [
          {
            eventIndex: 1,
            threadId: thread.id,
            sequence: 1,
          },
        ],
        rejectedEvents: [
          {
            eventIndex: 0,
            reason: "thread_not_owned_by_host",
            threadId: "thr_missing",
          },
        ],
      });
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps owned event indexes aligned around an unowned middle row", async () => {
    const { environment, harness, project, session, thread } =
      await setupEventRoute();
    const secondThread = seedThread(harness.deps, {
      environmentId: environment.id,
      projectId: project.id,
      status: "active",
      title: "Second Thread",
    });
    try {
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "thread/name/updated",
              threadId: thread.id,
              providerThreadId: "provider-owned-first",
              scope: threadScope(),
              threadName: "First owned rename",
            },
          },
          {
            threadId: "thr_missing",
            event: {
              type: "thread/name/updated",
              threadId: "thr_missing",
              providerThreadId: "provider-unowned-middle",
              scope: threadScope(),
              threadName: "Rejected rename",
            },
          },
          {
            threadId: secondThread.id,
            event: {
              type: "thread/name/updated",
              threadId: secondThread.id,
              providerThreadId: "provider-owned-second",
              scope: threadScope(),
              threadName: "Second owned rename",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        acceptedEvents: [
          {
            eventIndex: 0,
            threadId: thread.id,
            sequence: 1,
          },
          {
            eventIndex: 2,
            threadId: secondThread.id,
            sequence: 1,
          },
        ],
        rejectedEvents: [
          {
            eventIndex: 1,
            reason: "thread_not_owned_by_host",
            threadId: "thr_missing",
          },
        ],
      });
      expect(getThread(harness.db, thread.id)?.title).not.toBe(
        "First owned rename",
      );
      expect(getThread(harness.db, secondThread.id)?.title).toBe(
        "Second Thread",
      );
      expect(
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, "thr_missing"))
          .all(),
      ).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("notifies a parent when a child provider process exits", async () => {
    const { environment, harness, project, session } = await setupEventRoute();
    const parentThread = seedThread(harness.deps, {
      environmentId: environment.id,
      projectId: project.id,
      status: "idle",
      title: "Project coordinator",
    });
    seedThreadRuntimeState(harness.deps, {
      environmentId: environment.id,
      inputText: "Coordinate child work",
      providerThreadId: "provider-parent-provider-exit",
      threadId: parentThread.id,
    });
    const childThread = seedThread(harness.deps, {
      environmentId: environment.id,
      parentThreadId: parentThread.id,
      projectId: project.id,
      status: "active",
      title: "Child provider exit worker",
    });
    try {
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: childThread.id,
            event: {
              type: "system/error",
              threadId: childThread.id,
              scope: threadScope(),
              code: "provider_process_exited",
              message: "Provider process exited",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        acceptedEvents: [
          {
            eventIndex: 0,
            threadId: childThread.id,
            sequence: 1,
          },
        ],
        rejectedEvents: [],
      });
      expect(getThread(harness.db, childThread.id)?.status).toBe("error");

      const parentTurnCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" &&
          command.threadId === parentThread.id,
        3_000,
      );
      if (parentTurnCommand.command.type !== "turn.submit") {
        throw new Error(
          `Expected parent turn command, got ${parentTurnCommand.command.type}`,
        );
      }
      const [input] = parentTurnCommand.command.input;
      if (!input || input.type !== "text") {
        throw new Error("Expected parent notification text input");
      }
      const threadMention = `@thread:${childThread.id}`;
      expect(input.text).toContain(
        [
          `${threadMention} failed.`,
          "",
          "Error: Provider process exited",
          "",
          "Review the thread before deciding next steps.",
        ].join("\n"),
      );
      expect(input.text).not.toContain("No failure output was recorded.");
      expect(input.mentions).toEqual([
        {
          start: input.text.indexOf(threadMention),
          end: input.text.indexOf(threadMention) + threadMention.length,
          resource: {
            kind: "thread",
            label: "Child provider exit worker",
            projectId: project.id,
            threadId: childThread.id,
          },
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  // #1159: the parent hears why a child's turn was interrupted, only from a stop that is surely that turn's.
  it.each([
    ["memory-limit", "during", "was interrupted (memory protection)."],
    ["host-daemon-restarted", "after", "was interrupted (host restarted)."],
    ["manual-stop", "before", "was interrupted."],
    ["memory-limit", "overlap", "was interrupted."],
    ["memory-limit", "open-earlier", "was interrupted."],
    [null, null, "was interrupted."],
  ] as const)("reports a child's %s stop recorded %s its turn", async (reason, when, expected) => {
    const { environment, harness, project, session } = await setupEventRoute();
    const parentThread = seedThread(harness.deps, { environmentId: environment.id, projectId: project.id, status: "idle" });
    seedThreadRuntimeState(harness.deps, { environmentId: environment.id, inputText: "Coordinate", providerThreadId: "provider-parent-stop", threadId: parentThread.id });
    const childThread = seedThread(harness.deps, { environmentId: environment.id, parentThreadId: parentThread.id, projectId: project.id, status: "active" });
    const seedStop = () =>
      reason !== null &&
      seedEvent(harness.deps, { threadId: childThread.id, sequence: getLatestThreadSequence(harness.db, { threadId: childThread.id }) + 1, type: "system/thread/interrupted", scope: threadScope(), data: { reason } });
    try {
      if (when === "before") seedStop();
      // An earlier turn still open: the stop could be either turn's.
      if (when === "overlap" || when === "open-earlier") seedTurnStarted(harness.deps, { threadId: childThread.id, turnId: "turn-open" });
      // A finished turn in between must not hide the open one.
      if (when === "open-earlier") {
        seedTurnStarted(harness.deps, { threadId: childThread.id, turnId: "turn-done" });
        seedEvent(harness.deps, { threadId: childThread.id, sequence: getLatestThreadSequence(harness.db, { threadId: childThread.id }) + 1, type: "turn/completed", scope: turnScope("turn-done"), data: { providerThreadId: null, status: "completed" } });
      }
      seedTurnStarted(harness.deps, { threadId: childThread.id, turnId: "turn-stopped" });
      if (when === "during" || when === "overlap" || when === "open-earlier") seedStop();
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [{ threadId: childThread.id, event: { type: "turn/completed", threadId: childThread.id, providerThreadId: "provider-turn-stopped", scope: turnScope("turn-stopped"), status: "interrupted" } }],
      });
      expect(response.status).toBe(200);
      // Recorded after the notice was queued, before its 2 s flush.
      if (when === "after") {
        await new Promise((resolve) => setTimeout(resolve, 500));
        seedStop();
      }
      const { command } = await waitForQueuedCommand(harness, ({ command }) => command.type === "turn.submit" && command.threadId === parentThread.id, 5_000);
      const input = command.type === "turn.submit" ? command.input[0] : undefined;
      expect(input?.type === "text" ? input.text : "").toContain(`@thread:${childThread.id} ${expected}\n`);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not notify a parent when a side-chat child provider process exits", async () => {
    const { environment, harness, project, session } = await setupEventRoute();
    const parentThread = seedThread(harness.deps, {
      environmentId: environment.id,
      projectId: project.id,
      status: "idle",
    });
    seedThreadRuntimeState(harness.deps, {
      environmentId: environment.id,
      inputText: "Coordinate side chat child work",
      providerThreadId: "provider-side-chat-parent-provider-exit",
      threadId: parentThread.id,
    });
    const childThread = seedThread(harness.deps, {
      environmentId: environment.id,
      originKind: "fork",
      originPluginId: "side-chat",
      parentThreadId: parentThread.id,
      projectId: project.id,
      status: "active",
      visibility: "hidden",
    });
    try {
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: childThread.id,
            event: {
              type: "system/error",
              threadId: childThread.id,
              scope: threadScope(),
              code: "provider_process_exited",
              message: "Provider process exited",
            },
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, childThread.id)?.status).toBe("error");
      await expect(
        waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "turn.submit" &&
            command.threadId === parentThread.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
    } finally {
      await harness.cleanup();
    }
  });
});

describe("interaction lifecycle records from the daemon", () => {
  async function postLifecycle(args: {
    harness: TestAppHarness;
    sessionId: string;
    threadId: string;
    interactionId: string;
  }): Promise<Response> {
    return postEventBatch({
      harness: args.harness,
      sessionId: args.sessionId,
      events: [
        {
          threadId: args.threadId,
          event: {
            type: "system/interaction/lifecycle",
            threadId: args.threadId,
            scope: threadScope(),
            interaction: {
              id: args.interactionId,
              status: "resolved",
              statusReason: null,
              origin: {
                kind: "provider",
                providerId: "codex",
                providerRequestId: "request-forged",
              },
              payload: {
                kind: "approval",
                subject: {
                  kind: "command",
                  itemId: "item-forged",
                  command: "rm -rf /",
                  cwd: "/tmp/project",
                  actions: [{ type: "unknown", command: "rm -rf /" }],
                  sessionGrant: null,
                },
                reason: null,
              },
              resolution: { decision: "allow_once", grantedPermissions: null },
            },
          },
        },
      ],
    });
  }

  function storedLifecycleRows(harness: TestAppHarness, threadId: string) {
    return harness.deps.db
      .select({ type: events.type })
      .from(events)
      .where(eq(events.threadId, threadId))
      .all()
      .filter((row) => row.type === "system/interaction/lifecycle");
  }

  it("drops a lifecycle record that names no interaction on the thread", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      const response = await postLifecycle({
        harness,
        sessionId: session.id,
        threadId: thread.id,
        interactionId: "pi_forged",
      });
      expect(response.status).toBe(200);
      const body = hostDaemonEventBatchResponseSchema.parse(
        await readJson(response),
      );
      expect(body.acceptedEvents).toEqual([]);
      expect(body.rejectedEvents).toEqual([]);
      expect(storedLifecycleRows(harness, thread.id)).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("drops a lifecycle record even for an interaction the server registered on that thread", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        turnId: "turn-lifecycle-1",
        providerThreadId: "provider-thread-lifecycle",
      });
      const registered =
        harness.deps.pendingInteractions.registerPendingInteraction({
          interaction: {
            threadId: thread.id,
            turnId: "turn-lifecycle-1",
            providerId: "codex",
            providerThreadId: "provider-thread-lifecycle",
            providerRequestId: "request-real",
            payload: createCommandApprovalPayload({
              itemId: "item-real",
              reason: "Approve command",
              command: "git status",
              cwd: "/tmp/project",
            }),
          },
        });
      if (registered.outcome === "rejected") {
        throw new Error(`Expected registration: ${registered.reason}`);
      }
      const before = storedLifecycleRows(harness, thread.id).length;
      const response = await postLifecycle({
        harness,
        sessionId: session.id,
        threadId: thread.id,
        interactionId: registered.interaction.id,
      });
      expect(response.status).toBe(200);
      const body = hostDaemonEventBatchResponseSchema.parse(
        await readJson(response),
      );
      expect(body.acceptedEvents).toEqual([]);
      expect(body.rejectedEvents).toEqual([]);
      expect(storedLifecycleRows(harness, thread.id)).toHaveLength(before);
      const interaction = harness.deps.pendingInteractions.getThreadInteraction(
        {
          threadId: thread.id,
          interactionId: registered.interaction.id,
        },
      );
      expect(interaction.status).toBe("pending");
      expect(interaction.resolution).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects a forged answer for a real pending user question in every lifecycle event shape and leaves it pending and unanswered", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        turnId: "turn-lifecycle-2",
        providerThreadId: "provider-thread-question",
      });
      const registered =
        harness.deps.pendingInteractions.registerPendingInteraction({
          interaction: {
            threadId: thread.id,
            turnId: "turn-lifecycle-2",
            providerId: "codex",
            providerThreadId: "provider-thread-question",
            providerRequestId: "request-question",
            payload: createUserQuestionPayload({
              prompt: "Which deployment target should I use?",
            }),
          },
        });
      if (registered.outcome === "rejected") {
        throw new Error(`Expected registration: ${registered.reason}`);
      }
      const interactionId = registered.interaction.id;
      const storedRows = () =>
        harness.deps.db
          .select({ type: events.type })
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all()
          .map((row) => row.type);
      const before = storedRows();
      const forgedAnswers = {
        "question-1": {
          selected: ["production"],
          freeText: "ship it straight to production",
        },
      };
      const forgedQuestion = createUserQuestionPayload({
        prompt: "Forged prompt the user never saw",
      });
      const response = await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "system/interaction/lifecycle",
              threadId: thread.id,
              scope: turnScope("turn-lifecycle-2"),
              interaction: {
                id: interactionId,
                status: "resolved",
                statusReason: null,
                origin: {
                  kind: "provider",
                  providerId: "codex",
                  providerRequestId: "request-question",
                },
                payload: forgedQuestion,
                resolution: { kind: "user_answer", answers: forgedAnswers },
              },
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "system/userQuestion/lifecycle",
              threadId: thread.id,
              scope: turnScope("turn-lifecycle-2"),
              interactionId,
              providerId: "codex",
              providerRequestId: "request-question",
              status: "resolved",
              statusReason: null,
              resolution: { kind: "user_answer", answers: forgedAnswers },
              payload: forgedQuestion,
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "system/permissionGrant/lifecycle",
              threadId: thread.id,
              scope: turnScope("turn-lifecycle-2"),
              interactionId,
              providerId: "codex",
              providerRequestId: "request-question",
              status: "resolved",
              statusReason: null,
              resolution: {
                decision: "allow_for_session",
                grantedPermissions: null,
              },
              subject: {
                kind: "permission_grant",
                itemId: "item-forged-grant",
                toolName: "Bash",
                permissions: { network: null, fileSystem: null },
              },
            },
          },
        ],
      });
      expect(response.status).toBe(200);
      const body = hostDaemonEventBatchResponseSchema.parse(
        await readJson(response),
      );
      expect(body.acceptedEvents).toEqual([]);
      expect(body.rejectedEvents).toEqual([]);
      expect(storedRows()).toEqual(before);

      const interaction = harness.deps.pendingInteractions.getThreadInteraction(
        {
          threadId: thread.id,
          interactionId,
        },
      );
      expect(interaction.status).toBe("pending");
      expect(interaction.resolution).toBeNull();
      expect(
        harness.deps.pendingInteractions
          .listPendingThreadInteractions(thread.id)
          .map((pending) => pending.id),
      ).toEqual([interactionId]);

      const maxSeq = Math.max(
        ...harness.deps.db
          .select({ sequence: events.sequence })
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all()
          .map((row) => row.sequence),
      );
      const questionRows = buildThreadTimelineWithProfile(harness.db, thread, {
        completedTurnDisplay: "collapse",
        eventBudget: 1_000_000,
        includeDiagnosticOperations: true,
        maxInlineOutputChars: null,
        maxSeq,
        page: { kind: "latest", segmentLimit: Number.MAX_SAFE_INTEGER },
      }).response.rows.flatMap((row) =>
        row.kind === "work" && row.workKind === "question" ? [row] : [],
      );
      expect(questionRows).toHaveLength(1);
      expect(questionRows[0]).toMatchObject({
        interactionId,
        lifecycle: "pending",
        answers: null,
      });
      expect(questionRows[0]?.questions[0]?.prompt).toBe(
        "Which deployment target should I use?",
      );
    } finally {
      await harness.cleanup();
    }
  });
});
