import {
  DEFAULT_DESTROYED_ENVIRONMENT_EVENT_DETACH_BATCH_SIZE,
  DEFAULT_DESTROYED_ENVIRONMENT_PRUNE_BATCH_SIZE,
  DESTROYED_ENVIRONMENT_TTL_MS,
  environments,
  getThread,
  pruneDestroyedEnvironments,
} from "@cloudroom/db";
import type { ThreadStatus } from "@cloudroom/domain";
import { apiErrorSchema } from "@cloudroom/server-contract";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import { readThreadProvisionContext } from "../../src/services/threads/thread-startup-store.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const EIGHT_DAYS_MS = 8 * 24 * 60 * 60_000;

function seedThreadWithEnvironment(deps: Parameters<typeof seedThread>[0]) {
  const { host } = seedHostSession(deps);
  const { project } = seedProjectWithSource(deps, { hostId: host.id });
  const environment = seedEnvironment(deps, {
    hostId: host.id,
    projectId: project.id,
    environmentProviderId: "personal-workspace",
    isGitRepo: false,
  });
  const thread = seedThread(deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: "idle",
  });
  return { environment, thread };
}

function retireEnvironmentPastPruneTtl(
  deps: Parameters<typeof seedThread>[0],
  environmentId: string,
) {
  deps.db
    .update(environments)
    .set({
      status: "destroyed",
      teardownStatus: "removed",
      updatedAt: Date.now() - EIGHT_DAYS_MS,
    })
    .where(eq(environments.id, environmentId))
    .run();
  return pruneDestroyedEnvironments(deps.db, deps.hub, {
    updatedBefore: Date.now() - DESTROYED_ENVIRONMENT_TTL_MS,
    eventBatchSize: DEFAULT_DESTROYED_ENVIRONMENT_EVENT_DETACH_BATCH_SIZE,
    limit: DEFAULT_DESTROYED_ENVIRONMENT_PRUNE_BATCH_SIZE,
  }).deleted;
}

function seedThreadWithPrunedEnvironment(
  deps: Parameters<typeof seedThread>[0],
) {
  const { environment, thread } = seedThreadWithEnvironment(deps);
  deps.db.delete(environments).where(eq(environments.id, environment.id)).run();

  const threadAfterPrune = getThread(deps.db, thread.id);
  expect(threadAfterPrune?.environmentId).toBeNull();
  expect(threadAfterPrune?.archivedAt).toBeNull();
  return { thread };
}

function seedPointerlessThread(
  deps: Parameters<typeof seedThread>[0],
  status: ThreadStatus,
) {
  const { host } = seedHostSession(deps);
  const { project } = seedProjectWithSource(deps, { hostId: host.id });
  return seedThread(deps, { projectId: project.id, status });
}

async function expectArchiveRefused(
  harness: TestAppHarness,
  threadId: string,
): Promise<void> {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/archive-all`,
    { method: "POST" },
  );
  expect(response.status).toBe(409);
  expect(apiErrorSchema.parse(await readJson(response))).toMatchObject({
    code: "thread_environment_unavailable",
    details: { reason: "never_attached" },
  });
  expect(getThread(harness.deps.db, threadId)?.archivedAt).toBeNull();
}

describe("archive after environment prune", () => {
  it("POST /threads/:id/archive-all succeeds for a thread whose environment was pruned", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadWithPrunedEnvironment(harness.deps);
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/archive-all`,
        { method: "POST" },
      );
      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({
        ok: true,
        archivedThreadIds: [thread.id],
      });
      expect(getThread(harness.deps.db, thread.id)?.archivedAt).not.toBeNull();
    });
  });

  it.each<ThreadStatus>(["starting", "stopping"])(
    "keeps refusing archive for a %s thread that has no environment yet",
    async (status) => {
      await withTestHarness(async (harness) => {
        const thread = seedPointerlessThread(harness.deps, status);
        await expectArchiveRefused(harness, thread.id);
      });
    },
  );
});

describe("unarchive after environment retirement", () => {
  it("keeps the environment through prune so unarchive and send restore it", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadWithEnvironment(harness.deps);
      const post = (path: string, body?: unknown) =>
        harness.app.request(`/api/v1/threads/${thread.id}/${path}`, {
          method: "POST",
          ...(body === undefined
            ? {}
            : {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
        });
      expect((await post("archive-all")).status).toBe(200);
      expect(
        retireEnvironmentPastPruneTtl(harness.deps, environment.id),
      ).toBe(0);
      expect((await post("unarchive")).status).toBe(200);

      const response = await post("send", {
        input: textInput("Continue after unarchive"),
        mode: "auto",
        model: "gpt-5",
      });
      expect(response.status, await response.text()).toBe(200);
      expect(getThread(harness.deps.db, thread.id)).toMatchObject({
        archivedAt: null,
        environmentId: environment.id,
        status: "starting",
      });
      expect(readThreadProvisionContext(harness.deps.db, thread.id)).not.toBeNull();
    });
  });
});
