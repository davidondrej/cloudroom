import { and, eq } from "drizzle-orm";
import { events, getThread, listQueuedThreadMessages } from "@cloudroom/db";
import {
  threadScope,
  turnRequestEventDataSchema,
  turnScope,
} from "@cloudroom/domain";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
} from "@cloudroom/host-daemon-contract";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { queueChildThreadTurnNotificationBestEffort } from "../../../src/services/threads/child-thread-notifications.js";
import { sendThreadMessage } from "../../../src/services/threads/thread-send.js";
import {
  internalAuthHeaders,
  reportQueuedCommandError,
  waitForQueuedCommand,
} from "../../helpers/commands.js";
import { textInput } from "../../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

interface FamilyFixture {
  child: ReturnType<typeof seedThread>;
  environment: ReturnType<typeof seedEnvironment>;
  parent: ReturnType<typeof seedThread>;
  sessionId: string;
}

function seedFamily(harness: TestAppHarness, suffix: string): FamilyFixture {
  const { host, session } = seedHostSession(harness.deps, {
    id: `host-${suffix}`,
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const parent = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    title: "Parent",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-parent-${suffix}`,
    threadId: parent.id,
  });
  const child = seedThread(harness.deps, {
    environmentId: environment.id,
    parentThreadId: parent.id,
    projectId: project.id,
    title: "Child",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-child-${suffix}`,
    threadId: child.id,
  });
  return {
    child,
    environment,
    parent,
    sessionId: session.id,
  };
}

async function postEventBatch(args: {
  events: HostDaemonEventEnvelope[];
  harness: TestAppHarness;
  sessionId: string;
}): Promise<Response> {
  return args.harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(args.harness),
    body: JSON.stringify({
      sessionId: args.sessionId,
      eventGroups: groupHostDaemonEvents(args.events),
    }),
  });
}

function parentSystemMessageKinds(
  harness: TestAppHarness,
  parentThreadId: string,
): string[] {
  return harness.db
    .select()
    .from(events)
    .where(
      and(
        eq(events.threadId, parentThreadId),
        eq(events.type, "client/turn/requested"),
      ),
    )
    .all()
    .flatMap((row) => {
      const data = turnRequestEventDataSchema.parse(JSON.parse(row.data));
      return data.initiator === "system" && data.systemMessageKind
        ? [data.systemMessageKind]
        : [];
    });
}

describe("child outcome reconciliation", () => {
  it("does not report a failed outcome after a later accepted turn becomes active", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedFamily(harness, "late-acceptance");
      await sendThreadMessage(harness.deps, {
        environment: fixture.environment,
        payload: {
          input: textInput("continue"),
          mode: "start",
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        thread: fixture.child,
        trigger: "user",
      });
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" &&
          command.threadId === fixture.child.id,
      );
      if (queued.command.type !== "turn.submit") {
        throw new Error("Expected a turn submission");
      }

      await reportQueuedCommandError(harness, queued, {
        errorCode: "command_timeout",
        errorMessage: "Timed out waiting for command result",
      });
      expect(getThread(harness.db, fixture.child.id)?.status).toBe("active");
      const turnId = "turn-late-acceptance";
      const response = await postEventBatch({
        harness,
        sessionId: fixture.sessionId,
        events: [
          {
            threadId: fixture.child.id,
            event: {
              type: "turn/started",
              threadId: fixture.child.id,
              providerThreadId: `provider-child-late-acceptance`,
              scope: turnScope(turnId),
            },
          },
          {
            threadId: fixture.child.id,
            event: {
              type: "turn/input/accepted",
              threadId: fixture.child.id,
              providerThreadId: `provider-child-late-acceptance`,
              scope: turnScope(turnId),
              clientRequestId: queued.command.requestId,
            },
          },
        ],
      });
      expect(response.status).toBe(200);
      expect(getThread(harness.db, fixture.child.id)?.status).toBe("active");

      await new Promise((resolve) => setTimeout(resolve, 2_100));

      expect(getThread(harness.db, fixture.child.id)?.status).toBe("active");
      expect(parentSystemMessageKinds(harness, fixture.parent.id)).toEqual([]);
    });
  });

  it("keeps one outcome when the same child is queued twice", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedFamily(harness, "duplicate");
      for (let index = 0; index < 2; index += 1) {
        await queueChildThreadTurnNotificationBestEffort(harness.deps, {
          childThread: fixture.child,
          parentThreadId: fixture.parent.id,
          turnStatus: "failed",
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 2_100));

      expect(parentSystemMessageKinds(harness, fixture.parent.id)).toEqual([
        "child-failed",
      ]);
    });
  });

  // full/free: writes fail with SQLITE_FULL or work; stall/pass: deliveries
  // stall on a gate or run; open: reopens gates oldest first; held: notices
  // queue behind a pending interaction (#1542).
  it.each([
    [
      ["full", "stall", "failed", "pass", "open", "free", "wait"],
      "child-failed",
    ],
    [
      ["full", "stall", "failed", "completed", "pass", "open", "free", "wait"],
      "child-completed",
    ],
    [
      ["full", "failed", "free", "stall", "wait", "pass", "completed", "open"],
      "child-completed",
    ],
    [
      ["full", "failed", "free", "held", "wait", "completed"],
      "child-completed",
    ],
  ] as const)(
    "after %j the parent gets one %s",
    async (steps, expected) => {
      await withTestHarness(async (harness) => {
        const fixture = seedFamily(harness, "disk-full");
        const sleep = (ms: number) =>
          new Promise((resolve) => setTimeout(resolve, ms));
        const gates: (() => void)[] = [];
        let full: { mockRestore(): void } | undefined;
        let stall: { mockRestore(): void } | undefined;
        for (const step of steps) {
          if (step === "full") {
            full = vi
              .spyOn(harness.db, "transaction")
              .mockImplementation(() => {
                throw new Database.SqliteError(
                  "database or disk is full",
                  "SQLITE_FULL",
                );
              });
          } else if (step === "free") full?.mockRestore();
          else if (step === "held") {
            vi.spyOn(
              harness.deps.pendingInteractions,
              "hasPendingThreadInteraction",
            ).mockReturnValue(true);
          } else if (step === "stall") {
            stall = vi
              .spyOn(harness.deps.providerRegistry, "whenRegistrationsSettled")
              .mockImplementation(
                () => new Promise<void>((resolve) => gates.push(resolve)),
              );
          } else if (step === "pass") stall?.mockRestore();
          else if (step === "open") {
            for (const open of gates.splice(0)) {
              open();
              await sleep(500);
            }
          } else if (step === "wait") await sleep(5_500);
          else {
            await queueChildThreadTurnNotificationBestEffort(harness.deps, {
              childThread: fixture.child,
              parentThreadId: fixture.parent.id,
              turnStatus: step,
            });
            await sleep(2_100);
          }
        }

        // Sent or queued, the parent hears of the child exactly once.
        const queued = listQueuedThreadMessages(harness.db, fixture.parent.id);
        expect([
          ...parentSystemMessageKinds(harness, fixture.parent.id),
          ...queued.map((row) => JSON.parse(row.systemNotice ?? "{}").kind),
        ]).toEqual([expected]);
      });
    },
    20_000,
  );

  it("reports a waiting child again only once a background command finished, not every turn it wakes itself (#862)", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedFamily(harness, "waiting");
      const event = (turnId: string, data: Record<string, unknown>) =>
        ({
          threadId: fixture.child.id,
          event: {
            threadId: fixture.child.id,
            providerThreadId: "provider-child-waiting",
            scope: turnScope(turnId),
            ...data,
          },
        }) as HostDaemonEventEnvelope;
      const task = (id: string, done: boolean) => ({
        type: "backgroundTask",
        id,
        taskType: "local_bash",
        description: "Wait for tests",
        status: done ? "completed" : "pending",
        taskStatus: done ? "completed" : "running",
        skipTranscript: false,
      });
      // turn-2 only starts more work, so it is dropped. turn-3 finishes one
      // command while it runs and starts another, so it reports though the
      // count is the same, and so does turn-4, which may answer that result.
      for (const [turnId, finished, notices] of [
        ["turn-1", null, 1],
        ["turn-2", null, 1],
        ["turn-3", "task:turn-1", 2],
        ["turn-4", null, 3],
      ] as const) {
        await postEventBatch({
          harness,
          sessionId: fixture.sessionId,
          events: [
            event(turnId, { type: "turn/started" }),
            ...(finished === null
              ? []
              : [
                  event(turnId, {
                    type: "item/backgroundTask/completed",
                    scope: threadScope(),
                    item: task(finished, true),
                  }),
                ]),
            event(turnId, {
              type: "item/started",
              item: task(`task:${turnId}`, false),
            }),
            event(turnId, { type: "turn/completed", status: "completed" }),
          ],
        });
        await new Promise((resolve) => setTimeout(resolve, 2_100));
        expect(
          parentSystemMessageKinds(harness, fixture.parent.id).length +
            listQueuedThreadMessages(harness.db, fixture.parent.id).length,
        ).toBe(notices);
      }
    });
  }, 15_000);
});
