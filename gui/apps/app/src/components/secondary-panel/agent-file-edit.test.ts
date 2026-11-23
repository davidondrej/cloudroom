import { turnScope } from "@cloudroom/domain";
import {
  buildThreadTimelineFromEvents,
  type ThreadEventWithMeta,
} from "@cloudroom/thread-view";
import { describe, expect, it } from "vitest";
import { findActiveFileEdit } from "@/components/right-panel/tabs/agent-file-edit";

const ROOT = "/repo";
let seq = 0;

function event(body: Record<string, unknown>): ThreadEventWithMeta {
  seq += 1;
  return {
    event: {
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      ...body,
    },
    meta: { id: `event-${seq}`, seq, createdAt: seq },
  } as ThreadEventWithMeta;
}

function edit(path: string, kind: "add" | "update", diff: string) {
  return event({
    type: "item/completed",
    item: {
      type: "fileChange",
      id: `edit-${seq}`,
      changes: [{ path: `${ROOT}/${path}`, kind, diff }],
      status: "completed",
      approvalStatus: null,
    },
  });
}

// The rows the app really gets, from the same builder the server uses.
function rows(events: ThreadEventWithMeta[]) {
  return buildThreadTimelineFromEvents({
    acceptedClientRequestContext: {
      acceptedClientRequestEvents: [],
      rejectedClientRequestEvents: [],
    },
    contextWindowEvents: [],
    events,
    options: {
      completedTurnDisplay: "collapse",
      includeNestedRows: true,
      includeDiagnosticOperations: false,
      isLatestPage: true,
      threadStatus: "active",
      threadName: "",
      turnMessageDetail: "full",
      workspaceRoot: ROOT,
    },
  }).rows;
}

describe("findActiveFileEdit", () => {
  const started = event({ type: "turn/started" });
  const claudeEdit = edit(
    "docs/plan.md",
    "update",
    "--- a/repo/docs/plan.md\n+++ b/repo/docs/plan.md\n+## Agenda\n+",
  );

  it("finds the last written line while the turn runs", () => {
    expect(findActiveFileEdit(rows([started, claudeEdit]), "docs/plan.md")).toEqual(
      { lastLine: "## Agenda" },
    );
  });

  it("stops once the turn ends", () => {
    const done = event({ type: "turn/completed", status: "completed" });
    expect(
      findActiveFileEdit(rows([started, claudeEdit, done]), "docs/plan.md"),
    ).toBeNull();
  });

  it("matches the exact path only", () => {
    expect(findActiveFileEdit(rows([started, claudeEdit]), "plan.md")).toBeNull();
  });

  it("reads new files that arrive as plain text", () => {
    const codexAdd = edit("notes.md", "add", "# Notes\nFirst point\n");
    expect(findActiveFileEdit(rows([started, codexAdd]), "notes.md")).toEqual({
      lastLine: "First point",
    });
  });
});
