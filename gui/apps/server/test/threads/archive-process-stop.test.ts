import { threads } from "@cloudroom/db";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { scheduleArchivedThreadProcessStop } from "../../src/services/threads/thread-commands.js";
import {
  listQueuedThreadCommands,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

afterEach(() => vi.useRealTimers());

it("stops an archived thread's processes only for its latest archive", async () => {
  await withTestHarness(async (harness) => {
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
      environmentProviderId: "personal-workspace",
      isGitRepo: false,
    });
    const thread = seedThread(harness.deps, {
      environmentId: environment.id,
      projectId: project.id,
      status: "idle",
    });
    const archive = (archivedAt: number) => {
      harness.deps.db
        .update(threads)
        .set({ archivedAt })
        .where(eq(threads.id, thread.id))
        .run();
      scheduleArchivedThreadProcessStop(harness.deps, {
        threadId: thread.id,
        archivedAt,
        environment,
      });
    };

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    archive(1_000);
    archive(2_000);
    vi.advanceTimersByTime(10_000);
    vi.useRealTimers();

    const queued = await waitForQueuedCommand(
      harness,
      ({ command }) => command.type === "thread.processes.stop",
    );
    expect(queued.command).toEqual({
      type: "thread.processes.stop",
      environmentId: environment.id,
      threadId: thread.id,
    });
    expect(
      listQueuedThreadCommands(harness, "thread.processes.stop", thread.id),
    ).toHaveLength(1);
  });
});
