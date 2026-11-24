import { expect, it } from "vitest";
import { cloudroomThreads, createThread, getThread, threads } from "@cloudroom/db";
import { eq } from "drizzle-orm";
import { projectRecord } from "../../src/services/cloudroom/events.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

// Opening a sleeping Cloud thread wakes its sandbox, and Core reports `resuming`, then `idle`. That wake moved the
// thread to the top of the sidebar as if a message came. Only a turn that ended or failed is new activity, as on Local.
it.each([
  { name: "a wake", states: ["resuming", "idle"], shown: ["idle", "idle"], moved: false },
  { name: "a turn that ended", states: ["running", "idle"], shown: ["active", "idle"], moved: true },
  { name: "a failure while asleep", states: ["process_lost"], shown: ["error"], moved: true },
])("moves a Cloud thread up after $name: $moved", async ({ states, shown, moved }) => {
  const harness = await createTestAppHarness();
  try {
    const { db, hub } = harness.deps;
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
    const thread = createThread(db, hub, { executionTarget: "cloud", projectId: project.id, providerId: "claude-code", status: "idle" });
    db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: "http://core", startRequestId: "start", sessionId: "cr_attention", nativeId: "native", model: "m", reasoning: "medium" }).run();
    db.update(threads).set({ latestAttentionAt: 1 }).where(eq(threads.id, thread.id)).run();
    const statuses = states.map((state, index) => {
      projectRecord(db, thread.id, { sequence: index + 1, timestamp_ms: 1, session_id: "cr_attention", kind: "state", data: { state } });
      return getThread(db, thread.id)!.status;
    });
    expect(statuses).toEqual(shown);
    expect(getThread(db, thread.id)!.latestAttentionAt > 1).toBe(moved);
  } finally {
    await harness.cleanup();
  }
});
