import { expect, it } from "vitest";
import { cloudroomThreads, createThread, events } from "@cloudroom/db";
import { asc, eq } from "drizzle-orm";
import type { Json } from "../../src/services/cloudroom/client.js";
import { projectRecord } from "../../src/services/cloudroom/events.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

type Send = (kind: string, data: Json, native?: object) => void;

// What the desktop shows for each harness's messages, reasoning, and tool calls. The phone builds the same items from
// the same records (gui/apps/app/src/cloud/cloud-timeline.ts), so a change here usually belongs there too.
it.each([
  {
    providerId: "claude-code",
    records: (send: Send) => {
      const base = { harness: "claude-code", request_id: "t1" };
      send("item_started", { ...base, item_id: "think", item_type: "thinking" });
      send("thinking_delta", { ...base, item_id: "think", delta: "Plan" });
      send("item_completed", { ...base, item_id: "think", item_type: "thinking", text: "Plan" });
      send("item_started", { ...base, item_id: "msg", item_type: "text" });
      send("text_delta", { ...base, item_id: "msg", delta: "Hello" });
      send("item_completed", { ...base, item_id: "msg", item_type: "text", text: "Hello" });
      send("item_started", { ...base, item_id: "tool", item_type: "tool_use", tool_name: "Bash", input: { command: "pwd" } });
      send("item_completed", { ...base, item_id: "tool", item_type: "tool_use", tool_name: "Bash", result: "/code", is_error: false });
      send("item_started", { ...base, item_id: "bad", item_type: "tool_use", input: { command: "false" } });
      send("item_completed", { ...base, item_id: "bad", item_type: "tool_use", result: null, is_error: true });
    },
  },
  {
    providerId: "acp-cursor",
    records: (send: Send) => {
      const base = { harness: "cursor", request_id: "t1" };
      send("item_started", { ...base, item_id: "think", item_type: "reasoning" });
      send("thinking_delta", { ...base, item_id: "think", delta: "Plan" });
      send("item_completed", { ...base, item_id: "think", item_type: "reasoning", text: "Plan" });
      send("item_started", { ...base, item_id: "msg", item_type: "agentMessage" });
      send("text_delta", { ...base, item_id: "msg", delta: "Hello" });
      send("item_completed", { ...base, item_id: "msg", item_type: "agentMessage", text: "Hello" });
      const tool = { toolCallId: "tool", title: "Run pwd", kind: "execute", rawInput: { command: "pwd" } };
      send("item_started", { ...base, item_id: "tool", tool: { ...tool, status: "pending" } });
      send("tool_snapshot", { ...base, item_id: "tool", tool: { ...tool, status: "in_progress", content: [{ type: "content", content: { type: "text", text: "/co" } }] } });
      send("item_completed", { ...base, item_id: "tool", tool: { ...tool, status: "completed", rawOutput: { output: "/code" } } });
      send("item_completed", { ...base, item_id: "bad", tool: { toolCallId: "bad", kind: "edit", status: "failed" } });
      send("warning", { ...base, message: "Slow tool" });
    },
  },
  {
    providerId: "codex",
    records: (send: Send) => {
      const frame = (method: string, params: object) => send("native_event", { harness: "codex" }, { method, params: { threadId: "native", ...params } });
      frame("turn/started", { turn: { id: "turn" } });
      frame("item/started", { item: { type: "userMessage", id: "user", content: [] } });
      frame("item/started", { item: { type: "commandExecution", id: "cmd", command: "pwd", cwd: "/code", status: "inProgress", exitCode: null, durationMs: null, aggregatedOutput: null, commandActions: [] } });
      frame("item/commandExecution/outputDelta", { itemId: "cmd", delta: "/code" });
      frame("item/completed", { item: { type: "commandExecution", id: "cmd", command: "pwd", cwd: "/code", status: "completed", exitCode: 0, durationMs: 5, aggregatedOutput: "/code", commandActions: [] } });
      frame("item/started", { item: { type: "fileChange", id: "edit", status: "inProgress", changes: [{ path: "a.ts", kind: { type: "update" }, diff: "" }] } });
      frame("item/completed", { item: { type: "fileChange", id: "edit", status: "declined", changes: [{ path: "a.ts", kind: { type: "update" }, diff: "" }] } });
      frame("item/started", { item: { type: "somethingNew", id: "odd", detail: 1 } });
      frame("item/reasoning/summaryTextDelta", { itemId: "why", delta: "Because" });
      frame("item/started", { item: { type: "agentMessage", id: "msg", text: "" } });
      frame("item/agentMessage/delta", { itemId: "msg", delta: "Done" });
      frame("item/completed", { item: { type: "agentMessage", id: "msg", text: "Done" } });
      frame("item/completed", { item: { type: "subAgentActivity", id: "child", agentThreadId: "child-thread", agentPath: "explorer" } });
      frame("turn/completed", { turn: { id: "turn", status: "completed" } });
    },
  },
])("shows Cloud $providerId messages, reasoning, and tools like the desktop always has", async ({ providerId, records }) => {
  const harness = await createTestAppHarness();
  try {
    const { db, hub } = harness.deps;
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
    const thread = createThread(db, hub, { executionTarget: "cloud", projectId: project.id, providerId, status: "idle" });
    db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: "http://core", startRequestId: "start", sessionId: "cr_items", nativeId: "native", model: "m", reasoning: "medium" }).run();
    let sequence = 0;
    const send: Send = (kind, data, native) => void projectRecord(db, thread.id, {
      sequence: ++sequence, timestamp_ms: 1700000000000 + sequence, session_id: "cr_items", kind, data,
      ...(native ? { native: JSON.stringify(native) } : {}),
    });
    send("receipt", { request_id: "t1", command: "prompt", state: "accepted", input: { text: "check" } });
    send("state", { state: "starting_turn", request_id: "t1" });
    records(send);

    const stored = db.select({ data: events.data }).from(events).where(eq(events.threadId, thread.id)).orderBy(asc(events.sequence)).all();
    const shown = stored.map((row) => JSON.parse(row.data.replaceAll(thread.id, "THREAD")) as Record<string, unknown>)
      .filter((event) => String(event.type).startsWith("item/") || event.type === "provider/warning");
    expect(shown).toMatchSnapshot();
  } finally {
    await harness.cleanup();
  }
});
