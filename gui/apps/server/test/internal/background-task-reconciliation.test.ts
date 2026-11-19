import {
  closeSession,
  getAppSettings,
  getThread,
  listEvents,
  listQueuedThreadMessages,
  setAppSettings,
  setThreadExecutionOverride,
} from "@cloudroom/db";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonServerWsMessageSchema,
} from "@cloudroom/host-daemon-contract";
import { threadScope, turnScope } from "@cloudroom/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settleDanglingBackgroundTasks } from "../../src/services/threads/background-task-reconciliation.js";
import { runStartupRecoverySweep } from "../../src/services/system/periodic-sweeps.js";
import {
  handleDaemonSocketClosed,
  startRunningTurnDeadlinesAfterRestart,
} from "../../src/internal/session-owner-side-effects.js";
import {
  DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS,
  DAEMON_DISCONNECT_GRACE_MS,
} from "../../src/constants.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHost,
  seedProjectWithSource,
  seedStoredEvent,
  seedThread,
  seedThreadFixture,
  seedTurnStarted,
} from "../helpers/seed.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function backgroundTaskItemData(args: {
  itemId: string;
  taskStatus: string;
  status: string;
}): Record<string, unknown> {
  return {
    providerThreadId: "claude-session-1",
    item: {
      id: args.itemId,
      type: "backgroundTask",
      taskType: "local_workflow",
      description: "fixture workflow",
      status: args.status,
      taskStatus: args.taskStatus,
      skipTranscript: false,
      workflowName: "fixture-mini",
      usage: { totalTokens: 100, toolUses: 2, durationMs: 1500 },
    },
  };
}

interface SeedOpenBackgroundTaskArgs {
  /** The task runs in a child of the fixture thread. */
  asChild?: boolean;
  itemId?: string;
  taskStatus?: string;
  status?: string;
}

function seedOpenBackgroundTaskThread(
  harness: TestAppHarness,
  args: SeedOpenBackgroundTaskArgs = {},
) {
  const fixture = seedThreadFixture(harness, {});
  const thread = args.asChild
    ? seedThread(harness.deps, {
        projectId: fixture.project.id,
        environmentId: fixture.environment.id,
        parentThreadId: fixture.thread.id,
      })
    : fixture.thread;
  const itemId = args.itemId ?? "task:wf-1";
  seedStoredEvent(harness.deps, {
    threadId: thread.id,
    environmentId: fixture.environment.id,
    sequence: 1,
    type: "turn/started",
    scope: turnScope("turn-1"),
    providerThreadId: "claude-session-1",
    data: { providerThreadId: "claude-session-1" },
  });
  seedStoredEvent(harness.deps, {
    threadId: thread.id,
    environmentId: fixture.environment.id,
    sequence: 2,
    type: "item/started",
    scope: turnScope("turn-1"),
    providerThreadId: "claude-session-1",
    itemId,
    itemKind: "backgroundTask",
    data: backgroundTaskItemData({
      itemId,
      status: "pending",
      taskStatus: "running",
    }),
  });
  seedStoredEvent(harness.deps, {
    threadId: thread.id,
    environmentId: fixture.environment.id,
    sequence: 3,
    type: "item/backgroundTask/progress",
    scope: threadScope(),
    providerThreadId: "claude-session-1",
    itemId,
    itemKind: "backgroundTask",
    data: backgroundTaskItemData({
      itemId,
      status: args.status ?? "pending",
      taskStatus: args.taskStatus ?? "running",
    }),
  });
  return { ...fixture, parent: fixture.thread, thread, itemId };
}

function seedActiveTurnThread(harness: TestAppHarness) {
  const fixture = seedThreadFixture(harness, {
    thread: { status: "active" },
  });
  seedTurnStarted(harness.deps, {
    environmentId: fixture.environment.id,
    threadId: fixture.thread.id,
    turnId: "turn-live-1",
  });
  return fixture;
}

function listSettledBackgroundTaskItems(
  harness: TestAppHarness,
  threadId: string,
): Array<{ status: string; taskStatus: string }> {
  return listEvents(harness.deps.db, { threadId })
    .filter((row) => row.type === "item/backgroundTask/completed")
    .map((row) => {
      const { item } = JSON.parse(row.data) as {
        item: { status: string; taskStatus: string };
      };
      return { status: item.status, taskStatus: item.taskStatus };
    });
}

describe("settleDanglingBackgroundTasks", () => {
  it("settles open backgroundTask items as interrupted and is idempotent", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);
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

      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 1,
        type: "turn/started",
        scope: turnScope("turn-1"),
        providerThreadId: "claude-session-1",
        data: { providerThreadId: "claude-session-1" },
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 2,
        type: "item/started",
        scope: turnScope("turn-1"),
        providerThreadId: "claude-session-1",
        itemId: "task:wf-1",
        itemKind: "backgroundTask",
        data: backgroundTaskItemData({
          itemId: "task:wf-1",
          status: "pending",
          taskStatus: "running",
        }),
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 3,
        type: "item/backgroundTask/progress",
        scope: threadScope(),
        providerThreadId: "claude-session-1",
        itemId: "task:wf-1",
        itemKind: "backgroundTask",
        data: backgroundTaskItemData({
          itemId: "task:wf-1",
          status: "pending",
          taskStatus: "running",
        }),
      });

      settleDanglingBackgroundTasks(harness.deps, { hostId: host.id });

      const rows = listEvents(harness.deps.db, { threadId: thread.id });
      const completed = rows.filter(
        (row) => row.type === "item/backgroundTask/completed",
      );
      expect(completed).toHaveLength(1);
      const data = JSON.parse(completed[0]!.data) as {
        item: { status: string; taskStatus: string; workflowName: string };
      };
      expect(data.item.status).toBe("interrupted");
      expect(data.item.taskStatus).toBe("stopped");
      expect(data.item.workflowName).toBe("fixture-mini");

      settleDanglingBackgroundTasks(harness.deps, { hostId: host.id });
      expect(
        listEvents(harness.deps.db, { threadId: thread.id }).filter(
          (row) => row.type === "item/backgroundTask/completed",
        ),
      ).toHaveLength(1);
    });
  });

  it("does not touch already-settled tasks or other hosts", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);
      const otherHost = seedHost(harness.deps, {
        id: "host_other",
        name: "Other Host",
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

      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 1,
        type: "turn/started",
        scope: turnScope("turn-1"),
        data: { providerThreadId: "claude-session-1" },
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 2,
        type: "item/started",
        scope: turnScope("turn-1"),
        itemId: "task:wf-done",
        itemKind: "backgroundTask",
        data: backgroundTaskItemData({
          itemId: "task:wf-done",
          status: "pending",
          taskStatus: "running",
        }),
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 3,
        type: "item/backgroundTask/completed",
        scope: threadScope(),
        itemId: "task:wf-done",
        itemKind: "backgroundTask",
        data: backgroundTaskItemData({
          itemId: "task:wf-done",
          status: "completed",
          taskStatus: "completed",
        }),
      });

      settleDanglingBackgroundTasks(harness.deps, { hostId: otherHost.id });
      settleDanglingBackgroundTasks(harness.deps, { hostId: host.id });

      const completed = listEvents(harness.deps.db, {
        threadId: thread.id,
      }).filter((row) => row.type === "item/backgroundTask/completed");
      expect(completed).toHaveLength(1);
      const data = JSON.parse(completed[0]!.data) as {
        item: { status: string };
      };
      expect(data.item.status).toBe("completed");
    });
  });

  it("preserves an already-finished task status instead of stomping it to interrupted", async () => {
    await withTestHarness(async (harness) => {
      const { host, thread } = seedOpenBackgroundTaskThread(harness, {
        status: "completed",
        taskStatus: "completed",
      });

      settleDanglingBackgroundTasks(harness.deps, { hostId: host.id });

      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([
        { status: "completed", taskStatus: "completed" },
      ]);
    });
  });
});

describe("background-task lifecycle reconciliation triggers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles open tasks when a restarted daemon re-registers after its previous session already closed", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedOpenBackgroundTaskThread(harness);

      closeSession(
        harness.deps.db,
        harness.deps.hub,
        session.id,
        "daemon-disconnect",
      );

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
        }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-restarted",
          hostName: host.name,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-task-settle-restart",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(201);
      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([
        { status: "interrupted", taskStatus: "stopped" },
      ]);
    });
  });

  it("does not settle tasks when the same daemon instance reconnects", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedOpenBackgroundTaskThread(harness);

      closeSession(
        harness.deps.db,
        harness.deps.hub,
        session.id,
        "daemon-disconnect",
      );

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
        }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-1",
          hostName: host.name,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-task-settle-same-instance",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(201);
      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([]);
    });
  });

  it("does not tell a live daemon to shut down when that same instance reconnects", async () => {
    await withTestHarness(async (harness) => {
      setAppSettings(harness.db, { ...getAppSettings(harness.db), stripAiCoAuthorsEnabled: false });
      const { host, session, thread } = seedOpenBackgroundTaskThread(harness);
      const previousSocket = createMockHubSocket();
      harness.deps.hub.registerDaemon(session.id, host.id, previousSocket);

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
        }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: session.instanceId,
          hostName: host.name,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-task-live-same-instance",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(201);
      expect(
        previousSocket.messages.map((message) =>
          hostDaemonServerWsMessageSchema.parse(JSON.parse(message)),
        ),
      ).toEqual([
        {
          type: "machine-environment.replace",
          environment: { revision: expect.any(Number), entries: [] },
        },
      ]);
      expect(previousSocket.closed).toEqual([
        { code: 1000, reason: "replaced" },
      ]);
      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([]);
    });
  });

  it("still tells a superseded daemon instance to shut down", async () => {
    await withTestHarness(async (harness) => {
      setAppSettings(harness.db, { ...getAppSettings(harness.db), stripAiCoAuthorsEnabled: false });
      const { host, session, thread } = seedOpenBackgroundTaskThread(harness);
      const previousSocket = createMockHubSocket();
      harness.deps.hub.registerDaemon(session.id, host.id, previousSocket);

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
        }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-restarted",
          hostName: host.name,
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-daemon-task-live-restarted",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(201);
      expect(
        previousSocket.messages.map((message) =>
          hostDaemonServerWsMessageSchema.parse(JSON.parse(message)),
        ),
      ).toEqual([
        {
          type: "machine-environment.replace",
          environment: { revision: expect.any(Number), entries: [] },
        },
        { type: "session-close", reason: "replaced" },
      ]);
      expect(previousSocket.closed).toEqual([
        { code: 1000, reason: "replaced" },
      ]);
      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([
        { status: "interrupted", taskStatus: "stopped" },
      ]);
    });
  });

  it.each([
    ["a new daemon tells", "instance-restarted", 1],
    ["the same daemon never tells", "instance-1", 0],
  ])(
    "%s an idle child's parent about its lost background work",
    async (_label, instanceId, notices) => {
      await withTestHarness(async (harness) => {
        const { host, session, parent } = seedOpenBackgroundTaskThread(
          harness,
          { asChild: true },
        );
        setThreadExecutionOverride(harness.deps.db, {
          threadId: parent.id,
          modelOverride: "gpt-5",
        });
        vi.useFakeTimers({ toFake: ["setTimeout"] });
        handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
        vi.advanceTimersByTime(DAEMON_DISCONNECT_GRACE_MS + 1);
        vi.useRealTimers();

        await harness.app.request("/internal/session/open", {
          method: "POST",
          headers: internalAuthHeaders(harness, { hostId: host.id }),
          body: JSON.stringify({
            hostId: host.id,
            instanceId,
            hostName: host.name,
            hasMachineCredential: false,
            platform: "darwin",
            dataDir: "/tmp/host-daemon-task-lost-notice",
            localApiPort: null,
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
            activeThreads: [],
          }),
        });

        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(
          [
            ...listQueuedThreadMessages(harness.deps.db, parent.id),
            ...listEvents(harness.deps.db, { threadId: parent.id }),
          ].filter((row) =>
            JSON.stringify(row).includes("lost its background work"),
          ),
        ).toHaveLength(notices);
      });
    },
  );

  it("settles open tasks after the disconnect grace elapses without a reconnect", async () => {
    await withTestHarness(async (harness) => {
      const { session, thread } = seedOpenBackgroundTaskThread(harness);

      vi.useFakeTimers();
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });

      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([]);

      vi.advanceTimersByTime(DAEMON_DISCONNECT_GRACE_MS + 1);
      expect(listSettledBackgroundTaskItems(harness, thread.id)).toEqual([
        { status: "interrupted", taskStatus: "stopped" },
      ]);
    });
  });
});

describe("active thread disconnect reconciliation triggers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // After a tunnel flap the daemon can wait its full 30 s reconnect backoff,
  // so each case reconnects 31 s after the drop (#1956).
  async function reopenSameInstance(
    harness: TestAppHarness,
    args: { hostId: string; hostName: string; activeThreadIds: string[] },
  ): Promise<string> {
    await vi.advanceTimersByTimeAsync(31_000);
    const response = await harness.app.request("/internal/session/open", {
      method: "POST",
      headers: internalAuthHeaders(harness, { hostId: args.hostId }),
      body: JSON.stringify({
        hostId: args.hostId,
        instanceId: "instance-1",
        hostName: args.hostName,
        hasMachineCredential: false,
        platform: "darwin",
        dataDir: "/tmp/host-daemon-active-same-instance",
        localApiPort: null,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        activeThreads: args.activeThreadIds.map((threadId) => ({ threadId })),
      }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { sessionId: string }).sessionId;
  }

  function listTypesAfterTurnStart(harness: TestAppHarness, threadId: string) {
    return listEvents(harness.deps.db, { threadId })
      .filter((row) => row.type !== "turn/started")
      .map((row) => row.type);
  }

  it("keeps a running turn when the same daemon's socket comes back within the grace", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedActiveTurnThread(harness);

      vi.useFakeTimers();
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
      const sessionId = await reopenSameInstance(harness, {
        hostId: host.id,
        hostName: host.name,
        activeThreadIds: [thread.id],
      });
      harness.deps.hub.registerDaemon(
        sessionId,
        host.id,
        createMockHubSocket(),
      );
      await vi.advanceTimersByTimeAsync(DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS);

      expect(getThread(harness.deps.db, thread.id)?.status).toBe("active");
      expect(listTypesAfterTurnStart(harness, thread.id)).toEqual([]);
    });
  });

  it("interrupts by the deadline when the session reopens but its socket never arrives", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedActiveTurnThread(harness);

      vi.useFakeTimers();
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
      await reopenSameInstance(harness, {
        hostId: host.id,
        hostName: host.name,
        activeThreadIds: [thread.id],
      });
      await vi.advanceTimersByTimeAsync(
        DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS - 31_000 - 1,
      );
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("active");

      await vi.advanceTimersByTimeAsync(1);
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("error");
      expect(listTypesAfterTurnStart(harness, thread.id)).toEqual([
        "turn/completed",
        "system/error",
        "system/thread/interrupted",
      ]);
    });
  });

  it("starts the deadline when a reopen replaces the socket before its close callback runs", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedActiveTurnThread(harness);
      harness.deps.hub.registerDaemon(
        session.id,
        host.id,
        createMockHubSocket(),
      );

      vi.useFakeTimers();
      await reopenSameInstance(harness, {
        hostId: host.id,
        hostName: host.name,
        activeThreadIds: [thread.id],
      });
      // The old socket's close callback arrives after the replacement.
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
      await vi.advanceTimersByTimeAsync(
        DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS - 1,
      );
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("active");

      await vi.advanceTimersByTimeAsync(1);
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("error");
    });
  });

  it("re-arms the running-turn deadline when an HTTP-only reopen revives an interrupted turn", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedActiveTurnThread(harness);

      vi.useFakeTimers();
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
      await vi.advanceTimersByTimeAsync(DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS);
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("error");

      // The daemon still runs the turn, but its new socket never arrives.
      await reopenSameInstance(harness, {
        hostId: host.id,
        hostName: host.name,
        activeThreadIds: [thread.id],
      });
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("active");
      await vi.advanceTimersByTimeAsync(DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS);
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("error");
    });
  });

  it("leaves the restart re-arm to the listener, not the startup sweep", async () => {
    await withTestHarness(async (harness) => {
      const { session, thread } = seedActiveTurnThread(harness);
      harness.deps.hub.unregisterDaemon(session.id);

      vi.useFakeTimers();
      await runStartupRecoverySweep(harness.deps);
      await vi.advanceTimersByTimeAsync(DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS);
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("active");
    });
  });

  it("starts the running-turn deadline again after a server restart", async () => {
    await withTestHarness(async (harness) => {
      // A restarted server: a running turn, no daemon socket and no timers.
      const { session, thread } = seedActiveTurnThread(harness);
      harness.deps.hub.unregisterDaemon(session.id);

      vi.useFakeTimers();
      startRunningTurnDeadlinesAfterRestart(harness.deps);
      await vi.advanceTimersByTimeAsync(
        DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS - 1,
      );
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("active");

      await vi.advanceTimersByTimeAsync(1);
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("error");
    });
  });

  it.each(["instance-1", "instance-restarted"])(
    "distinguishes a missing turn from a daemon restart for %s",
    async (instanceId) => {
      await withTestHarness(async (harness) => {
        const { host, session, thread } = seedActiveTurnThread(harness);

        handleDaemonSocketClosed(harness.deps, { sessionId: session.id });

        const response = await harness.app.request("/internal/session/open", {
          method: "POST",
          headers: internalAuthHeaders(harness, {
            hostId: host.id,
          }),
          body: JSON.stringify({
            hostId: host.id,
            instanceId,
            hostName: host.name,
            hasMachineCredential: false,
            platform: "darwin",
            dataDir: "/tmp/host-daemon-active-restarted-instance",
            localApiPort: null,
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
            activeThreads: [],
          }),
        });

        expect(response.status).toBe(201);
        expect(getThread(harness.deps.db, thread.id)?.status).toBe("error");
        const rows = listEvents(harness.deps.db, {
          threadId: thread.id,
        }).filter((row) => row.type !== "turn/started");
        expect(rows.map((row) => row.type)).toEqual([
          "turn/completed",
          "system/error",
          "system/thread/interrupted",
        ]);
        expect(JSON.parse(rows[0]!.data)).toMatchObject({
          status: "interrupted",
        });
        expect(JSON.parse(rows[1]!.data)).toMatchObject({
          code: "thread_command_failed",
          message:
            instanceId === "instance-1"
              ? "Thread interrupted because the connection to the host was lost"
              : "Thread interrupted because the host daemon disconnected",
          detail: "Please retry the thread to continue.",
        });
        expect(JSON.parse(rows[2]!.data)).toEqual({
          reason: "host-daemon-restarted",
          ...(instanceId === "instance-1"
            ? { cause: "host-connection-lost" }
            : {}),
        });
      });
    },
  );

  it("records a lost host connection after the live event window elapses without a reconnect", async () => {
    await withTestHarness(async (harness) => {
      const { session, thread } = seedActiveTurnThread(harness);

      vi.useFakeTimers();
      handleDaemonSocketClosed(harness.deps, { sessionId: session.id });

      await vi.advanceTimersByTimeAsync(DAEMON_DISCONNECT_GRACE_MS + 1);
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("active");
      expect(
        listEvents(harness.deps.db, { threadId: thread.id })
          .filter((row) => row.type !== "turn/started")
          .map((row) => row.type),
      ).toEqual([]);

      await vi.advanceTimersByTimeAsync(
        DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS - DAEMON_DISCONNECT_GRACE_MS,
      );
      expect(getThread(harness.deps.db, thread.id)?.status).toBe("error");
      expect(
        listEvents(harness.deps.db, { threadId: thread.id })
          .filter((row) => row.type !== "turn/started")
          .map((row) => ({
            data: JSON.parse(row.data),
            type: row.type,
          })),
      ).toEqual([
        expect.objectContaining({
          type: "turn/completed",
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            code: "thread_command_failed",
            message:
              "Thread interrupted because the connection to the host was lost",
            detail: "Please retry the thread to continue.",
          }),
          type: "system/error",
        }),
        expect.objectContaining({
          data: {
            reason: "host-daemon-restarted",
            cause: "host-connection-lost",
          },
          type: "system/thread/interrupted",
        }),
      ]);
    });
  });
});
