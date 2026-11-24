import { describe, expect, it } from "vitest";
import type { ThreadEventRow } from "@cloudroom/domain";
import type {
  TimelineCommandWorkRow,
  TimelineDelegationWorkRow,
  TimelineRow,
} from "@cloudroom/server-contract";
import {
  createTimelineEventFactory,
  renderTimelineFixture,
} from "./timeline-test-harness.js";

function flatten(rows: readonly TimelineRow[]): TimelineRow[] {
  return rows.flatMap((r) =>
    r.kind === "turn" && r.children
      ? [r, ...flatten(r.children)]
      : r.kind === "work" && r.workKind === "delegation"
        ? [r, ...flatten(r.childRows)]
        : [r],
  );
}

function projectCommands(
  events: ThreadEventRow[],
  threadStatus: "active" | "idle" = "active",
): TimelineCommandWorkRow[] {
  const rendered = renderTimelineFixture({
    events,
    projectionOptions: { threadStatus, turnMessageDetail: "full" },
  });
  return flatten(rendered.rows).filter(
    (r): r is TimelineCommandWorkRow =>
      r.kind === "work" && r.workKind === "command",
  );
}

function projectDelegations(
  events: ThreadEventRow[],
  threadStatus: "active" | "idle" = "active",
): TimelineDelegationWorkRow[] {
  const rendered = renderTimelineFixture({
    events,
    projectionOptions: { threadStatus, turnMessageDetail: "full" },
  });
  return flatten(rendered.rows).filter(
    (r): r is TimelineDelegationWorkRow =>
      r.kind === "work" && r.workKind === "delegation",
  );
}

describe("tool activity projection", () => {
  it("uses latest non-empty command text even when the latest command is shorter", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = projectCommands([
      f.turnStarted({ seq: 1 }),
      f.commandStarted({
        itemId: "command-1",
        command: "rg foo src/app.ts",
        aggregatedOutput: "started\n",
        seq: 2,
      }),
      f.commandCompleted({
        itemId: "command-1",
        command: "pnpm t",
        exitCode: 0,
        seq: 3,
      }),
    ]);

    expect(rows).toMatchObject([{ command: "pnpm t", activityIntents: [] }]);
  });

  it("uses latest non-null duration from terminal command updates", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = projectCommands([
      f.turnStarted({ seq: 1, createdAt: 1 }),
      f.commandStarted({ itemId: "command-1", command: "pnpm test", seq: 2, createdAt: 2 }),
      f.commandCompleted({ itemId: "command-1", command: "pnpm test", exitCode: 0, seq: 3, createdAt: 11 }),
      f.commandCompleted({ itemId: "command-1", command: "pnpm test", exitCode: 1, status: "failed", seq: 4, createdAt: 26 }),
    ]);

    expect(rows.map((r) => r.completedAt)).toEqual([26]);
  });

  it("leaves pending commands without a captured completedAt", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = projectCommands([
      f.turnStarted({ seq: 1, createdAt: 1 }),
      f.commandStarted({ itemId: "command-1", command: "pnpm test", seq: 2, createdAt: 1 }),
      f.commandOutputDelta({ itemId: "command-1", delta: "still running\n", seq: 3, createdAt: 2_001 }),
    ]);

    expect(rows[0]).toMatchObject({
      completedAt: null,
      status: "pending",
      startedAt: 1,
    });
  });

  it("applies late command output to a finalized history row", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = projectCommands([
      f.turnStarted({ seq: 1 }),
      f.commandStarted({ itemId: "command-1", command: "pnpm test", aggregatedOutput: "started\n", seq: 2 }),
      f.commandCompleted({ itemId: "command-1", command: "pnpm test", aggregatedOutput: "done\n", exitCode: 0, seq: 3 }),
      f.commandOutputDelta({ itemId: "command-1", delta: "late\n", seq: 4 }),
    ]);

    expect(rows).toMatchObject([{ output: "done\nlate\n", status: "completed" }]);
  });

  it("applies late command output to the newest finalized row for a reused call id", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = projectCommands([
      f.turnStarted({ seq: 1 }),
      f.commandStarted({ itemId: "command-1", command: "pnpm test", aggregatedOutput: "first started\n", seq: 2 }),
      f.commandCompleted({ itemId: "command-1", command: "pnpm test", aggregatedOutput: "first done\n", exitCode: 0, seq: 3 }),
      f.commandStarted({ itemId: "command-1", command: "pnpm test", aggregatedOutput: "second started\n", seq: 4 }),
      f.commandCompleted({ itemId: "command-1", command: "pnpm test", aggregatedOutput: "second done\n", exitCode: 0, seq: 5 }),
      f.commandOutputDelta({ itemId: "command-1", delta: "late\n", seq: 6 }),
    ]);

    expect(rows.map((r) => r.output)).toEqual(["first done\n", "second done\nlate\n"]);
  });

  it("replaces command output on reset deltas", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = projectCommands([
      f.turnStarted({ seq: 1 }),
      f.commandStarted({ itemId: "command-1", command: "pnpm test", seq: 2 }),
      f.commandOutputDelta({ itemId: "command-1", delta: "before reset\n", seq: 3 }),
      f.commandOutputDelta({ itemId: "command-1", delta: "after reset\n", reset: true, seq: 4 }),
      f.commandCompleted({ itemId: "command-1", command: "pnpm test", exitCode: 0, seq: 5 }),
    ]);

    expect(rows.map((r) => r.output)).toEqual(["after reset\n"]);
  });

  it("hides partial command output until a newline or terminal flush", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const prefix = [
      f.turnStarted({ seq: 1 }),
      f.commandStarted({ itemId: "command-1", command: "pnpm test", seq: 2 }),
      f.commandOutputDelta({ itemId: "command-1", delta: "partial", seq: 3 }),
    ];
    expect(projectCommands(prefix)[0]?.output).toBe("");

    const withNewline = [
      ...prefix,
      f.commandOutputDelta({ itemId: "command-1", delta: " line\ntrailing", seq: 4 }),
    ];
    expect(projectCommands(withNewline)[0]?.output).toBe("partial line\n");

    const completed = [
      ...withNewline,
      f.commandCompleted({ itemId: "command-1", command: "pnpm test", exitCode: 0, seq: 5 }),
    ];
    expect(projectCommands(completed)[0]?.output).toBe("partial line\ntrailing");
  });

  it("preserves equal-length pending output that differs from begin snapshot", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = projectCommands([
      f.turnStarted({ seq: 1 }),
      f.commandOutputDelta({ itemId: "command-1", delta: "pre\n", seq: 2 }),
      f.commandStarted({ itemId: "command-1", command: "pnpm test", aggregatedOutput: "run\n", seq: 3 }),
      f.commandCompleted({ itemId: "command-1", command: "pnpm test", exitCode: 0, seq: 4 }),
    ]);

    expect(rows.map((r) => r.output)).toEqual(["pre\nrun\n"]);
  });

  it("preserves pending output when a longer begin snapshot does not include it", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = projectCommands([
      f.turnStarted({ seq: 1 }),
      f.commandOutputDelta({ itemId: "command-1", delta: "pre\n", seq: 2 }),
      f.commandStarted({ itemId: "command-1", command: "pnpm test", aggregatedOutput: "begin-output\n", seq: 3 }),
      f.commandCompleted({ itemId: "command-1", command: "pnpm test", exitCode: 0, seq: 4 }),
    ]);

    expect(rows.map((r) => r.output)).toEqual(["pre\nbegin-output\n"]);
  });

  it("keeps interrupted command status when stale completion arrives", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = projectCommands([
      f.turnStarted({ seq: 1, createdAt: 1 }),
      f.commandStarted({ itemId: "command-1", command: "pnpm test", seq: 2, createdAt: 1 }),
      f.turnCompleted({ status: "interrupted", seq: 3, createdAt: 2 }),
      f.commandCompleted({ itemId: "command-1", command: "pnpm test", aggregatedOutput: "completed", exitCode: 0, seq: 4, createdAt: 3 }),
    ]);

    // Interrupted turn finalizes pending commands at turnCompleted (createdAt=2)
    expect(rows).toMatchObject([{ status: "completed" }]);
    // When explicitly interrupted before end via thread status idle/interrupted:
    const interruptedRows = projectCommands([
      f.turnStarted({ seq: 1, createdAt: 1 }),
      f.commandStarted({ itemId: "command-1", command: "pnpm test", seq: 2, createdAt: 1 }),
      f.commandCompleted({ itemId: "command-1", command: "pnpm test", status: "interrupted", seq: 3, createdAt: 2 }),
      f.commandCompleted({ itemId: "command-1", command: "pnpm test", status: "completed", exitCode: 0, seq: 4, createdAt: 3 }),
    ]);
    expect(interruptedRows).toMatchObject([{ completedAt: 2, status: "interrupted" }]);
  });

  it("keeps interrupted delegation status when stale completion arrives", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = projectDelegations([
      f.turnStarted({ seq: 1, createdAt: 1 }),
      f.delegationStarted({ itemId: "del-1", childRef: "child-1", label: "Review", seq: 2, createdAt: 1 }),
      f.delegationCompleted({ itemId: "del-1", childRef: "child-1", label: "Review", status: "interrupted", summary: "stopped", seq: 3, createdAt: 2 }),
      f.delegationCompleted({ itemId: "del-1", childRef: "child-1", label: "Review", status: "completed", summary: "done", seq: 4, createdAt: 3 }),
    ]);

    expect(rows).toMatchObject([{ completedAt: 2, status: "interrupted" }]);
  });

  it("lets error replace an interrupted command timestamp", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = projectCommands([
      f.turnStarted({ seq: 1, createdAt: 1 }),
      f.commandStarted({ itemId: "command-1", command: "pnpm test", seq: 2, createdAt: 1 }),
      f.commandCompleted({ itemId: "command-1", command: "pnpm test", status: "interrupted", seq: 3, createdAt: 2 }),
      f.commandCompleted({ itemId: "command-1", command: "pnpm test", status: "failed", exitCode: 1, seq: 4, createdAt: 4 }),
    ]);

    expect(rows).toMatchObject([{ completedAt: 4, status: "error" }]);
  });

  it("lets error replace finalized interrupted command status", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = projectCommands([
      f.turnStarted({ seq: 1 }),
      f.commandStarted({ itemId: "command-1", command: "pnpm test", seq: 2 }),
      f.commandCompleted({ itemId: "command-1", command: "pnpm test", status: "interrupted", seq: 3 }),
      f.commandCompleted({ itemId: "command-1", command: "pnpm test", status: "failed", exitCode: 1, seq: 4 }),
    ]);

    expect(rows.map((r) => r.status)).toEqual(["error"]);
  });

  it("lets error replace finalized completed command status", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const rows = projectCommands([
      f.turnStarted({ seq: 1 }),
      f.commandStarted({ itemId: "command-1", command: "pnpm test", seq: 2 }),
      f.commandCompleted({ itemId: "command-1", command: "pnpm test", status: "completed", exitCode: 0, seq: 3 }),
      f.commandCompleted({ itemId: "command-1", command: "pnpm test", status: "failed", exitCode: 1, seq: 4 }),
    ]);

    expect(rows.map((r) => r.status)).toEqual(["error"]);
  });
});
