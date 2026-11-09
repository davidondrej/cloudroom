import { expect, it } from "vitest";
import { cloudroomCommands, cloudroomThreads, countContextCompactions, createThread } from "@cloudroom/db";
import type { Json } from "../../src/services/cloudroom/client.js";
import { projectRecord } from "../../src/services/cloudroom/events.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

// The context ring counts these, so a compaction the agent starts by itself must count like a /compact command.
it.each([
  {
    providerId: "claude-code",
    compacted: { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto" } },
    ignored: [{ type: "system", subtype: "init" }],
    duringCompactCommand: { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual" } },
  },
  {
    providerId: "pi",
    compacted: { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false },
    ignored: [
      { type: "compaction_end", reason: "overflow", aborted: true, willRetry: false },
      { type: "compaction_end", reason: "overflow", aborted: false, willRetry: false, errorMessage: "Compaction failed" },
      { type: "compaction_end", reason: "manual", aborted: false, willRetry: false },
    ],
    duringCompactCommand: { type: "compaction_end", reason: "manual", aborted: false, willRetry: false },
  },
])("counts a Cloud $providerId compaction the agent starts by itself", async ({ providerId, compacted, ignored, duringCompactCommand }) => {
  const harness = await createTestAppHarness();
  try {
    const { db, hub } = harness.deps;
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
    const thread = createThread(db, hub, { executionTarget: "cloud", projectId: project.id, providerId, status: "idle" });
    db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: "http://core", startRequestId: "start", sessionId: "cr_compact", nativeId: "native", model: "m", reasoning: "medium" }).run();
    db.insert(cloudroomCommands).values({ id: "compact-1", threadId: thread.id, command: "compact", input: "{}", state: "running", createdAt: 0 }).run();
    let sequence = 0;
    const send = (kind: string, data: Json, native?: object) => projectRecord(db, thread.id, {
      sequence: ++sequence, timestamp_ms: 1700000000000 + sequence, session_id: "cr_compact", kind, data,
      ...(native ? { native: JSON.stringify(native) } : {}),
    });
    const frame = (requestId: string, native: { type: string }) => send("native_event", { harness: providerId, type: native.type, request_id: requestId }, native);

    send("state", { state: "starting_turn", request_id: "turn-1" });
    for (const native of ignored) expect(frame("turn-1", native)).not.toContain("thread/compacted");
    expect(frame("turn-1", compacted)).toEqual(["thread/compacted"]);
    // The compact command's completed receipt records this one.
    send("state", { state: "starting_turn", request_id: "compact-1" });
    expect(frame("compact-1", duringCompactCommand)).not.toContain("thread/compacted");

    expect(countContextCompactions(db, { threadId: thread.id, sequenceStart: 0 })).toBe(1);
  } finally {
    await harness.cleanup();
  }
});
