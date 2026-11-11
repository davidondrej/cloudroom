// #1248: Cloud records that can wait are saved together, and streamed pieces of one item become one event row.
// What is stored must be what one-record-at-a-time saving stores, with only neighbouring pieces joined.
import { expect, it } from "vitest";
import { cloudroomThreads, createThread, events } from "@cloudroom/db";
import { joinStreamDeltas, type ThreadEvent } from "@cloudroom/domain";
import { asc, eq } from "drizzle-orm";
import type { Json, SessionRecord } from "../../src/services/cloudroom/client.js";
import { isStreamDelta, projectRecord, projectRecords, recordSaving } from "../../src/services/cloudroom/events.js";
import { binding } from "../../src/services/cloudroom/store.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

type Send = (kind: string, data: Json, native?: object) => void;

const streams: { providerId: string; records: (send: Send) => void }[] = [
  {
    providerId: "claude-code",
    records: (send) => {
      const base = { harness: "claude-code", request_id: "t1" };
      send("item_started", { ...base, item_id: "think", item_type: "thinking" });
      for (const delta of ["Pl", "an ", "first"]) send("thinking_delta", { ...base, item_id: "think", delta });
      send("item_completed", { ...base, item_id: "think", item_type: "thinking", text: "Plan first" });
      send("native_record", { offset: 10 }, { type: "assistant" });
      send("item_started", { ...base, item_id: "msg", item_type: "text" });
      for (const delta of ["Hel", "lo\n", "wor"]) send("text_delta", { ...base, item_id: "msg", delta });
      // Any record that is not a streamed piece ends the run of pieces, also one that has no event of its own.
      send("native_record", { offset: 20 }, { type: "assistant" });
      send("text_delta", { ...base, item_id: "msg", delta: "ld" });
      send("usage", { contextUsage: { tokens: 10, contextWindow: 100 } });
      send("text_delta", { ...base, item_id: "msg", delta: "!" });
      send("item_completed", { ...base, item_id: "msg", item_type: "text", text: "Hello\nworld!" });
    },
  },
  {
    providerId: "codex",
    records: (send) => {
      const frame = (kind: string, method: string, params: object) => send(kind, { harness: "codex", method }, { method, params: { threadId: "native", ...params } });
      frame("native_event", "turn/started", { turn: { id: "turn" } });
      for (const delta of ["Be", "cause"]) frame("native_event", "item/reasoning/summaryTextDelta", { itemId: "why", delta });
      frame("item_started", "item/started", { item: { type: "commandExecution", id: "cmd", command: "pwd", cwd: "/code", status: "inProgress", exitCode: null, durationMs: null, aggregatedOutput: null, commandActions: [] } });
      for (const delta of ["/co", "de\n", "done\n"]) frame("tool_delta", "item/commandExecution/outputDelta", { itemId: "cmd", delta });
      frame("item_completed", "item/completed", { item: { type: "commandExecution", id: "cmd", command: "pwd", cwd: "/code", status: "completed", exitCode: 0, durationMs: 5, aggregatedOutput: "/code\ndone\n", commandActions: [] } });
      frame("item_started", "item/started", { item: { type: "agentMessage", id: "msg", text: "" } });
      // Two messages stream in turn: pieces of one never join across a piece of the other.
      frame("text_delta", "item/agentMessage/delta", { itemId: "msg", delta: "Do" });
      frame("text_delta", "item/agentMessage/delta", { itemId: "other", delta: "x" });
      frame("text_delta", "item/agentMessage/delta", { itemId: "msg", delta: "ne" });
      frame("text_delta", "item/agentMessage/delta", { itemId: "msg", delta: "." });
      frame("item_completed", "item/completed", { item: { type: "agentMessage", id: "msg", text: "Done." } });
      frame("native_event", "turn/completed", { turn: { id: "turn", status: "completed" } });
    },
  },
];

it.each(streams)("saves batched Cloud $providerId records as the same events, with neighbouring pieces joined", async ({ providerId, records }) => {
  const harness = await createTestAppHarness();
  try {
    const { db, hub } = harness.deps;
    const { host } = seedHostSession(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
    const sent: SessionRecord[] = [];
    const send: Send = (kind, data, native) => void sent.push({
      sequence: sent.length + 1, timestamp_ms: 1700000000000 + sent.length, session_id: "cr_batch", kind, data,
      ...(native ? { native: JSON.stringify(native) } : {}),
    });
    send("receipt", { request_id: "t1", command: "prompt", state: "accepted", input: { text: "check" } });
    send("state", { state: "starting_turn", request_id: "t1" });
    records(send);

    const count = (thread: string) => db.select({ id: events.id }).from(events).where(eq(events.threadId, thread)).all().length;
    const save = (group: (thread: string, records: SessionRecord[]) => void) => {
      const thread = createThread(db, hub, { executionTarget: "cloud", projectId: project.id, providerId, status: "idle" });
      const sessionId = `cr_${thread.id}`;
      db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: "http://core", startRequestId: `start_${thread.id}`, sessionId, nativeId: "native", model: "m", reasoning: "medium" }).run();
      group(thread.id, sent.map((record) => ({ ...record, session_id: sessionId })));
      const stored = db.select().from(events).where(eq(events.threadId, thread.id)).orderBy(asc(events.sequence)).all();
      return {
        cursor: binding(db, thread.id)?.cursor,
        events: stored.map((row) => JSON.parse(row.data.replaceAll(thread.id, "THREAD")) as ThreadEvent),
        times: stored.map((row) => row.createdAt),
      };
    };
    // One record at a time, as before #1248. `from[i]` is the record that event i came from.
    const from: number[] = [];
    const alone = save((thread, records) => records.forEach((record, index) => {
      projectRecord(db, thread, record);
      while (from.length < count(thread)) from.push(index);
    }));
    // The stream loop's rule, with a batch window that never ends on its own.
    const batched = save((thread, records) => {
      let waiting: SessionRecord[] = [];
      for (const record of records) {
        const saving = recordSaving(record);
        if (saving === "wait") { waiting.push(record); continue; }
        if (saving === "now") projectRecords(db, thread, [...waiting, record]);
        else { projectRecords(db, thread, waiting); projectRecord(db, thread, record); }
        waiting = [];
      }
      projectRecords(db, thread, waiting);
    });

    // Expected: the same events, where a piece joins the piece before it if only streamed pieces came between.
    const expected: ThreadEvent[] = [];
    const times: number[] = [];
    alone.events.forEach((event, index) => {
      const last = expected.at(-1);
      const onlyPiecesBetween = index > 0 && sent.slice(from[index - 1]! + 1, from[index]! + 1).every(isStreamDelta);
      const both = last && onlyPiecesBetween ? joinStreamDeltas(last, event) : null;
      if (both) expected[expected.length - 1] = both;
      // The first piece's time is the joined event's time.
      else { expected.push(event); times.push(alone.times[index]!); }
    });
    expect(batched.events).toEqual(expected);
    expect(batched.times).toEqual(times);
    expect(batched.cursor).toBe(sent.length);
    expect(alone.cursor).toBe(sent.length);
    // Joining really happened.
    expect(batched.events.length).toBeLessThan(alone.events.length - 3);
  } finally {
    await harness.cleanup();
  }
});

it("says which Cloud records wait, which are saved at once, and which the stream loop handles alone", () => {
  const record = (kind: string, data: Json = {}, native?: object): SessionRecord => ({ sequence: 1, session_id: "cr", kind, data, ...(native ? { native: JSON.stringify(native) } : {}) });
  expect(["text_delta", "thinking_delta", "tool_delta", "native_record", "usage", "tool_snapshot"].map((kind) => recordSaving(record(kind)))).toEqual(Array(6).fill("wait"));
  expect(recordSaving(record("native_event", { method: "item/reasoning/summaryTextDelta" }))).toBe("wait");
  expect(["item_started", "item_completed", "native_event"].map((kind) => recordSaving(record(kind, { method: "turn/completed" })))).toEqual(Array(3).fill("now"));
  // The loop does more than save these: status, child threads, receipts, rewinds, and kinds it does not know.
  expect(["state", "receipt", "child", "child_request", "fork_request", "rewind", "title", "native_identity", "archive", "storage_pause", "something_new"].map((kind) => recordSaving(record(kind)))).toEqual(Array(11).fill("alone"));
  // The loop asks OpenAI's status page about this error before it saves it.
  expect(recordSaving(record("native_event", { method: "error" }, { method: "error", params: { error: { message: "401 Unauthorized: Incorrect API key provided: sk-abc. https://chatgpt.com/backend-api/codex" } } }))).toBe("alone");
});
