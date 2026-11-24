import { expect, it } from "vitest";
import { cloudroomThreads, createThread } from "@cloudroom/db";
import type { Json } from "../../src/services/cloudroom/client.js";
import { projectRecord } from "../../src/services/cloudroom/events.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

// Claude's safeguards can switch a Cloud thread's model mid-run; the chat must say so, as for a Local thread (#1313).
it.each([
  { data: { original_model: "claude-opus-5-5", fallback_model: "claude-opus-4-8", message: "Claude switched to claude-opus-4-8 for the rest of this run." }, shown: true },
  { data: { original_model: null, fallback_model: "claude-opus-4-8", message: "x" }, shown: false },
])("shows Core's model_fallback record as a model fallback notice (shown: $shown)", async ({ data, shown }) => {
  const harness = await createTestAppHarness();
  try {
    const { db, hub } = harness.deps;
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
    const thread = createThread(db, hub, { executionTarget: "cloud", projectId: project.id, providerId: "claude-code", status: "idle" });
    db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: "http://core", startRequestId: "start", sessionId: "cr_fallback", nativeId: "native", model: "claude-opus-5-5", reasoning: "medium" }).run();
    const types = projectRecord(db, thread.id, { sequence: 1, timestamp_ms: 1700000000000, session_id: "cr_fallback", kind: "model_fallback", data: { harness: "claude-code", request_id: "turn-1", ...data } as Json });
    expect(types).toEqual(shown ? ["provider/modelFallback"] : []);
  } finally {
    await harness.cleanup();
  }
});
