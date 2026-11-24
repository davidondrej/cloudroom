import { describe, expect, it } from "vitest";
import type { ThreadEventRow } from "@cloudroom/domain";
import type { TimelineRow } from "@cloudroom/server-contract";
import {
  createTimelineEventFactory,
  renderTimelineFixture,
} from "./timeline-test-harness.js";

function renderCollapsed(events: ThreadEventRow[]): TimelineRow[] {
  return renderTimelineFixture({
    completedTurnDisplay: "collapse",
    events,
    includeNestedRows: true,
    projectionOptions: { threadStatus: "idle", turnMessageDetail: "full" },
  }).rows;
}

describe("completed turn grouping", () => {
  it("unwraps a singleton compaction group after a user message", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const req = f.clientTurnRequested({ text: "compact", seq: 1 });
    const rows = renderCollapsed([
      req,
      f.turnStarted({ seq: 2 }),
      f.inputAccepted({ clientRequestId: req.data.requestId, seq: 3 }),
      f.contextCompactionCompleted({ seq: 4 }),
      f.turnCompleted({ seq: 5 }),
    ]);

    expect(rows.map((r) => r.kind)).toEqual(["conversation", "system"]);
    expect(rows[1]).toMatchObject({
      kind: "system",
      systemKind: "operation",
      operationKind: "compaction",
    });
  });

  it("unwraps a singleton context-clear group", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = renderCollapsed([
      f.turnStarted({ seq: 1 }),
      f.threadContextCleared({ seq: 2 }),
      f.turnCompleted({ seq: 3 }),
    ]);

    expect(rows).toEqual([
      expect.objectContaining({
        kind: "system",
        systemKind: "operation",
        operationKind: "context-clear",
      }),
    ]);
  });

  it("uses one summary group when no messages are ungroupable", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = renderCollapsed([
      f.turnStarted({ seq: 1, createdAt: 1 }),
      f.commandCompleted({ itemId: "cmd-1", command: "pnpm test", seq: 2, createdAt: 2 }),
      f.commandCompleted({ itemId: "cmd-2", command: "pnpm lint", seq: 3, createdAt: 3 }),
      f.turnCompleted({ seq: 4, createdAt: 4 }),
    ]);

    expect(rows).toMatchObject([
      {
        kind: "turn",
        id: "thread-1:turn-1:turn",
        startedAt: 1,
        completedAt: 4,
        summaryCount: 2,
      },
    ]);
  });

  it("keeps an assistant response visible when more assistant text follows it directly", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = renderCollapsed([
      f.turnStarted({ seq: 1 }),
      f.assistantCompleted({ itemId: "a1", text: "answer", seq: 2 }),
      f.assistantCompleted({ itemId: "a2", text: "hook-reply", seq: 3 }),
      f.turnCompleted({ seq: 4 }),
    ]);

    expect(rows).toMatchObject([
      { kind: "conversation", role: "assistant", text: "answer" },
      { kind: "conversation", role: "assistant", text: "hook-reply" },
    ]);
  });

  it("folds narration that precedes work and keeps the response that precedes the terminal text", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = renderCollapsed([
      f.turnStarted({ seq: 1, createdAt: 1 }),
      f.assistantCompleted({ itemId: "n", text: "narration", seq: 2, createdAt: 2 }),
      f.commandCompleted({ itemId: "c", command: "pnpm test", seq: 3, createdAt: 3 }),
      f.assistantCompleted({ itemId: "a", text: "answer", seq: 4, createdAt: 4 }),
      f.assistantCompleted({ itemId: "h", text: "hook-reply", seq: 5, createdAt: 5 }),
      f.turnCompleted({ seq: 6, createdAt: 6 }),
    ]);

    expect(rows).toMatchObject([
      {
        kind: "turn",
        id: "thread-1:turn-1:turn:0",
        startedAt: 1,
        completedAt: 6,
        summaryCount: 2,
        children: [
          { kind: "conversation", role: "assistant", text: "narration" },
          { kind: "work", workKind: "command", callId: "c" },
        ],
      },
      { kind: "conversation", role: "assistant", text: "answer" },
      { kind: "conversation", role: "assistant", text: "hook-reply" },
    ]);
  });

  it("keeps every response in a run of adjacent assistant texts", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = renderCollapsed([
      f.turnStarted({ seq: 1 }),
      f.assistantCompleted({ itemId: "a1", text: "first", seq: 2 }),
      f.assistantCompleted({ itemId: "a2", text: "second", seq: 3 }),
      f.commandCompleted({ itemId: "c", command: "pnpm test", seq: 4 }),
      f.assistantCompleted({ itemId: "a3", text: "terminal", seq: 5 }),
      f.turnCompleted({ seq: 6 }),
    ]);

    expect(rows).toMatchObject([
      { kind: "conversation", role: "assistant", text: "first" },
      {
        kind: "turn",
        children: [
          { kind: "conversation", role: "assistant", text: "second" },
          { kind: "work", workKind: "command", callId: "c" },
        ],
      },
      { kind: "conversation", role: "assistant", text: "terminal" },
    ]);
  });

  it("preserves the last assistant message before an ungroupable user message", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const steer = f.clientTurnRequested({
      initiator: "user",
      target: { kind: "auto", expectedTurnId: "turn-1" },
      text: "user-steer",
      seq: 3,
    });
    const rows = renderCollapsed([
      f.turnStarted({ seq: 1 }),
      f.assistantCompleted({ itemId: "a1", text: "assistant-before", seq: 2 }),
      steer,
      f.inputAccepted({ clientRequestId: steer.data.requestId, seq: 4 }),
      f.assistantCompleted({ itemId: "a2", text: "assistant-after", seq: 5 }),
      f.turnCompleted({ seq: 6 }),
    ]);

    expect(rows).toMatchObject([
      { kind: "conversation", role: "assistant", text: "assistant-before" },
      { kind: "conversation", role: "user", text: "user-steer" },
      { kind: "conversation", role: "assistant", text: "assistant-after" },
    ]);
  });

  it("does not segment summary groups around agent and system steers", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const agentSteer = f.clientTurnRequested({
      initiator: "agent",
      target: { kind: "auto", expectedTurnId: "turn-1" },
      text: "agent-steer",
      seq: 3,
    });
    const systemSteer = f.clientTurnRequested({
      initiator: "system",
      target: { kind: "auto", expectedTurnId: "turn-1" },
      text: "system-steer",
      seq: 5,
    });
    const rows = renderCollapsed([
      f.turnStarted({ seq: 1, createdAt: 1 }),
      f.commandCompleted({ itemId: "c1", command: "pnpm test", seq: 2, createdAt: 2 }),
      agentSteer,
      f.inputAccepted({ clientRequestId: agentSteer.data.requestId, seq: 4, createdAt: 4 }),
      systemSteer,
      f.inputAccepted({ clientRequestId: systemSteer.data.requestId, seq: 6, createdAt: 6 }),
      f.commandCompleted({ itemId: "c2", command: "pnpm lint", seq: 7, createdAt: 7 }),
      f.turnCompleted({ seq: 8, createdAt: 8 }),
    ]);

    expect(rows).toMatchObject([
      {
        kind: "turn",
        id: "thread-1:turn-1:turn",
        startedAt: 1,
        completedAt: 8,
        summaryCount: 4,
      },
    ]);
  });

  it("segments summary groups around converted legacy user messages", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = renderCollapsed([
      f.turnStarted({ seq: 1, createdAt: 1 }),
      f.commandCompleted({ itemId: "c1", command: "pnpm test", seq: 2, createdAt: 2 }),
      f.legacyUserMessage({ text: "legacy-user-message", turnId: "turn-1", seq: 3, createdAt: 3 }),
      f.commandCompleted({ itemId: "c2", command: "pnpm lint", seq: 4, createdAt: 4 }),
      f.assistantCompleted({ itemId: "final", text: "done", seq: 5, createdAt: 5 }),
      f.turnCompleted({ seq: 6, createdAt: 6 }),
    ]);

    expect(rows).toMatchObject([
      { kind: "turn", id: "thread-1:turn-1:turn:0", summaryCount: 1 },
      { kind: "conversation", role: "assistant", text: "legacy-user-message" },
      { kind: "turn", id: "thread-1:turn-1:turn:1", summaryCount: 1 },
      { kind: "conversation", role: "assistant", text: "done" },
    ]);
  });

  it("slices terminal and trailing messages out of the summary groups", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = renderCollapsed([
      f.turnStarted({ seq: 1 }),
      f.commandCompleted({ itemId: "before", command: "pnpm test", seq: 2 }),
      f.assistantCompleted({ itemId: "terminal", text: "terminal", seq: 3 }),
      f.commandCompleted({ itemId: "trailing", command: "pnpm cleanup", seq: 4 }),
      f.turnCompleted({ seq: 5 }),
    ]);

    expect(rows).toMatchObject([
      {
        kind: "turn",
        children: [{ kind: "work", workKind: "command", callId: "before" }],
      },
      { kind: "conversation", role: "assistant", text: "terminal" },
      { kind: "work", workKind: "command", callId: "trailing" },
    ]);
  });
});
