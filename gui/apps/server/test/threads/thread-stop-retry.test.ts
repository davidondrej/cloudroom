import { setTimeout as sleep } from "node:timers/promises";
import { getThread, listEvents, markThreadDeleted } from "@cloudroom/db";
import type { EnvironmentRow } from "@cloudroom/db";
import type { Thread } from "@cloudroom/domain";
import { describe, expect, it } from "vitest";
import {
  finalizeStoppedThread,
  hasLiveThreadStopInFlight,
  requestThreadStorageDeletion,
  requestThreadStopForCurrentState,
  stopThreadForCurrentState,
} from "../../src/services/threads/thread-lifecycle.js";
import {
  internalAuthHeaders,
  listQueuedThreadCommands,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

interface ActiveThreadStopFixture {
  environment: EnvironmentRow;
  sessionId: string;
  thread: Thread;
}

interface SeedActiveThreadStopFixtureArgs {
  harness: TestAppHarness;
  status?: Thread["status"];
  value: number;
}

interface WaitForStopRpcIdleArgs {
  threadId: string;
}

function seedActiveThreadStopFixture(
  args: SeedActiveThreadStopFixtureArgs,
): ActiveThreadStopFixture {
  const { host, session } = seedHostSession(args.harness.deps, {
    id: `host-thread-stop-retry-${args.value}`,
  });
  const { project } = seedProjectWithSource(args.harness.deps, {
    hostId: host.id,
    path: `/tmp/thread-stop-retry-${args.value}`,
  });
  const environment = seedEnvironment(args.harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/thread-stop-retry-${args.value}`,
    status: "ready",
  });
  const thread = seedThread(args.harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: args.status ?? "active",
  });

  return { environment, sessionId: session.id, thread };
}

async function waitForStopRpcIdle(args: WaitForStopRpcIdleArgs): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (!hasLiveThreadStopInFlight(args.threadId)) {
      return;
    }
    await sleep(10);
  }

  throw new Error("Timed out waiting for live thread stop RPC to settle");
}

describe("thread stop dispatch", () => {
  it("keeps a deleted thread tombstone until storage deletion succeeds", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedActiveThreadStopFixture({
        harness,
        value: 5,
      });
      markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });

      requestThreadStorageDeletion(harness.deps, thread, environment);
      const failedDelete = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.storage.delete" &&
          command.threadId === thread.id,
      );
      expect(getThread(harness.db, thread.id)).toMatchObject({
        deletedAt: expect.any(Number),
        storageDeletedAt: null,
      });

      await reportQueuedCommandError(harness, failedDelete, {
        errorCode: "test_storage_delete_failure",
        errorMessage: "Test storage delete failure",
      });
      await sleep(10);
      expect(getThread(harness.db, thread.id)).toMatchObject({
        storageDeletedAt: null,
      });

      requestThreadStorageDeletion(harness.deps, thread, environment);
      const successfulDelete = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.storage.delete" &&
          command.threadId === thread.id,
      );
      await reportQueuedCommandSuccess(harness, successfulDelete, {
        providerCheckpointId: null,
      });

      expect(getThread(harness.db, thread.id)).toBeNull();
    });
  });

  it("keeps attached storage pending when its environment is unavailable", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedActiveThreadStopFixture({ harness, value: 6 });
      markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });

      requestThreadStorageDeletion(harness.deps, thread, null);

      expect(getThread(harness.db, thread.id)).toMatchObject({
        deletedAt: expect.any(Number),
        storageDeletedAt: null,
      });
      expect(
        listQueuedThreadCommands(harness, "thread.storage.delete", thread.id),
      ).toHaveLength(0);
    });
  });

  it("does not re-dispatch the stop after a live stop RPC failure", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedActiveThreadStopFixture({
        harness,
        value: 1,
      });

      requestThreadStopForCurrentState(harness.deps, thread, environment);

      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(hasLiveThreadStopInFlight(thread.id)).toBe(true);
      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "stopping",
      });

      await reportQueuedCommandError(harness, stopCommand, {
        errorCode: "test_thread_stop_failure",
        errorMessage: "Test live stop failure",
      });
      await waitForStopRpcIdle({ threadId: thread.id });

      expect(hasLiveThreadStopInFlight(thread.id)).toBe(false);
      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "stopping",
      });
      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id),
      ).toHaveLength(0);
    });
  });

  it("keeps a thread stopping and says so when one more stop can't confirm it (#917)", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedActiveThreadStopFixture({
        harness,
        value: 9,
      });
      const stop = () =>
        stopThreadForCurrentState(
          harness.deps,
          getThread(harness.db, thread.id)!,
          environment,
        ).catch((error: unknown) => error);
      const failNextStop = async (immediate?: true) => {
        const command = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.stop" &&
            command.threadId === thread.id &&
            command.immediate === immediate,
        );
        await reportQueuedCommandError(harness, command, {
          errorCode: "command_timeout",
          errorMessage: "Timed out waiting for command result",
        });
      };

      const first = stop();
      await failNextStop();
      await failNextStop(true);
      expect(await first).toMatchObject({
        body: { code: "thread_stop_unconfirmed" },
      });

      // No turn has started, yet a later Stop still asks the host.
      const second = stop();
      await failNextStop(true);
      expect(await second).toMatchObject({
        body: { code: "thread_stop_unconfirmed" },
      });
      expect(getThread(harness.db, thread.id)?.status).toBe("stopping");
    });
  });

  it("settles a stopped thread when the host reports no runtime exists", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedActiveThreadStopFixture({
        harness,
        value: 4,
      });

      requestThreadStopForCurrentState(harness.deps, thread, environment);

      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "stopping",
      });

      await reportQueuedCommandError(harness, stopCommand, {
        errorCode: "unknown_environment",
        errorMessage: "No runtime exists for environment env_missing_runtime",
      });
      await waitForStopRpcIdle({ threadId: thread.id });

      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "idle",
      });
      const threadEvents = listEvents(harness.db, { threadId: thread.id });
      expect(
        threadEvents.filter(
          (event) => event.type === "system/thread/interrupted",
        ),
      ).toHaveLength(1);
      expect(
        threadEvents.filter((event) => event.type === "turn/completed"),
      ).toHaveLength(0);
    });
  });

  it("stops a thread the memory guard reports as a stop, never a retryable failure", async () => {
    await withTestHarness(async (harness) => {
      const { sessionId, thread } = seedActiveThreadStopFixture({
        harness,
        value: 7,
      });

      const response = await harness.app.request(
        "/internal/session/thread-memory-limit",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId,
            threadId: thread.id,
            usedBytes: 70 * 2 ** 30,
            totalBytes: 128 * 2 ** 30,
          }),
        },
      );
      expect(response.status).toBe(200);
      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      await reportQueuedCommandError(harness, stopCommand, {
        errorCode: "unknown_environment",
        errorMessage: "No runtime exists for environment env_missing_runtime",
      });
      await waitForStopRpcIdle({ threadId: thread.id });

      // Idle, not error: a stop settles without `turn.failed`, so no retry.
      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "idle",
      });
      const interrupted = listEvents(harness.db, {
        threadId: thread.id,
      }).filter((event) => event.type === "system/thread/interrupted");
      expect(interrupted.map((event) => JSON.parse(event.data).reason)).toEqual(
        ["memory-limit"],
      );
    });
  });

  it("records a late memory report on a thread that already failed, once", async () => {
    await withTestHarness(async (harness) => {
      const { sessionId, thread } = seedActiveThreadStopFixture({
        harness,
        status: "error",
        value: 8,
      });
      const report = () =>
        harness.app.request("/internal/session/thread-memory-limit", {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId,
            threadId: thread.id,
            usedBytes: 70 * 2 ** 30,
            totalBytes: 128 * 2 ** 30,
          }),
        });

      expect((await report()).status).toBe(200);
      expect((await report()).status).toBe(200);

      const interrupted = listEvents(harness.db, {
        threadId: thread.id,
      }).filter((event) => event.type === "system/thread/interrupted");
      expect(interrupted.map((event) => JSON.parse(event.data).reason)).toEqual(
        ["memory-limit"],
      );
    });
  });

  it("treats a second stop completion as a no-op after the stop already settled", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedActiveThreadStopFixture({
        harness,
        value: 3,
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        threadId: thread.id,
        turnId: "turn-stop-settles-twice",
      });

      requestThreadStopForCurrentState(harness.deps, thread, environment);
      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      await reportQueuedCommandSuccess(harness, stopCommand, {
        providerCheckpointId: "pi-entry-at-stop",
      });
      const settled = getThread(harness.db, thread.id);
      expect(settled).toMatchObject({
        status: "idle",
      });

      finalizeStoppedThread(harness.deps, {
        threadId: thread.id,
      });

      expect(getThread(harness.db, thread.id)).toEqual(settled);
      const threadEvents = listEvents(harness.db, { threadId: thread.id });
      expect(
        threadEvents.filter((event) => event.type === "turn/completed"),
      ).toHaveLength(1);
      const completion = threadEvents.find(
        (event) => event.type === "turn/completed",
      );
      expect(completion).toBeDefined();
      expect(JSON.parse(completion?.data ?? "{}")).toMatchObject({
        providerCheckpointId: "pi-entry-at-stop",
        status: "interrupted",
      });
      expect(
        threadEvents.filter(
          (event) => event.type === "system/thread/interrupted",
        ),
      ).toHaveLength(1);
    });
  });

  it("does not queue duplicate stop commands while a stop RPC is in flight", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedActiveThreadStopFixture({
        harness,
        value: 2,
      });

      requestThreadStopForCurrentState(harness.deps, thread, environment);

      const firstStopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(hasLiveThreadStopInFlight(thread.id)).toBe(true);

      requestThreadStopForCurrentState(harness.deps, thread, environment);

      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id),
      ).toHaveLength(1);

      await reportQueuedCommandSuccess(harness, firstStopCommand, {
        providerCheckpointId: null,
      });
      await waitForStopRpcIdle({ threadId: thread.id });
    });
  });
});
