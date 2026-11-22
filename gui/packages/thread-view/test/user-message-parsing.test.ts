import { describe, expect, it } from "vitest";
import type { PromptTextMention } from "@cloudroom/domain";
import {
  createTimelineEventFactory,
  decodeThreadEventRow,
  type TimelineEventFactory,
} from "./timeline-test-harness.js";
import {
  parsePromptInput,
  type AcceptedClientRequest,
} from "../src/events.js";
import {
  buildClientUserRows,
  resolveTurnRequestKind,
  shouldPreservePendingMessages,
} from "../src/messages.js";

type ClientTurnRequestedEventRow = ReturnType<
  TimelineEventFactory["clientTurnRequested"]
>;

const AGENT_STEER_TEXT = "Please account for the restart";
const SENDER_THREAD_ID = "thr_sender";

function asRequested(row: ClientTurnRequestedEventRow) {
  const { event, meta } = decodeThreadEventRow(row);
  if (event.type !== "client/turn/requested") {
    throw new Error("Expected client/turn/requested event");
  }
  return { event, meta };
}

function parseUsers(
  row: ClientTurnRequestedEventRow,
  accepted?: AcceptedClientRequest,
) {
  const { event, meta } = asRequested(row);
  if (resolveTurnRequestKind(event, accepted) !== "message") return [];
  return buildClientUserRows(
    event,
    meta,
    accepted ? "accepted" : "pending",
    accepted,
    "active",
  );
}

function parsePendingSteers(row: ClientTurnRequestedEventRow) {
  const { event, meta } = asRequested(row);
  if (
    resolveTurnRequestKind(event, undefined) !== "steer" ||
    !shouldPreservePendingMessages("active")
  ) {
    return [];
  }
  return buildClientUserRows(event, meta, "pending", undefined, "active");
}

function parseAcceptedSteers(
  row: ClientTurnRequestedEventRow,
  accepted: AcceptedClientRequest,
) {
  const { event, meta } = asRequested(row);
  if (resolveTurnRequestKind(event, accepted) !== "steer") return [];
  return buildClientUserRows(event, meta, "accepted", accepted, "active");
}

function acceptedClientRequest(turnId = "turn-1"): AcceptedClientRequest {
  return { meta: { id: "event-accepted", seq: 2, createdAt: 2 }, turnId };
}

describe("user message parsing", () => {
  it("omits agent-only prompt input parts from timeline text and attachments", () => {
    const parsed = parsePromptInput([
      {
        type: "text",
        text: "[bb system]\n\nHidden agent-only context:\n\nsecret",
        mentions: [],
        visibility: "agent-only",
      },
      { type: "text", text: "Visible request", mentions: [] },
      { type: "localFile", path: "/tmp/hidden.md", visibility: "agent-only" },
      { type: "localFile", path: "/tmp/visible.md" },
    ]);

    expect(parsed).toEqual({
      text: "Visible request",
      mentions: [],
      webImages: 0,
      localImages: 0,
      localFiles: 1,
      imageUrls: [],
      localImagePaths: [],
      localFilePaths: ["/tmp/visible.md"],
    });
  });

  it("hides prompt input rows that only contain agent-only parts", () => {
    expect(
      parsePromptInput([
        {
          type: "text",
          text: "[bb system]\n\nHidden agent-only context was removed.",
          mentions: [],
          visibility: "agent-only",
        },
      ]),
    ).toBeNull();
  });

  it("populates initiator, senderThreadId, and turnRequest for user-initiated messages", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const row = parseUsers(
      f.clientTurnRequested({
        initiator: "user",
        target: { kind: "new-turn" },
        text: "Hello",
      }),
    )[0];

    expect(row).toMatchObject({
      kind: "conversation",
      role: "user",
      initiator: "user",
      senderThreadId: null,
      turnRequest: { isGrouped: false, kind: "message", status: "pending" },
      text: "Hello",
    });
  });

  it("renders grouped queued turn requests as separate user messages", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const req = f.clientTurnRequested({
      initiator: "user",
      target: { kind: "new-turn" },
      text: "First\n\nSecond",
      input: [{ type: "text", text: "First\n\nSecond", mentions: [] }],
      inputGroups: [
        [{ type: "text", text: "First", mentions: [] }],
        [{ type: "text", text: "Second", mentions: [] }],
      ],
    });
    const rows = parseUsers(req);

    expect(rows.map((r) => r.text)).toEqual(["First", "Second"]);
    expect(rows.map((r) => r.id)).toEqual([
      `thread-1:user-seed:${req.seq}`,
      `thread-1:user-seed:${req.seq}-1`,
    ]);
    expect(rows.map((r) => r.turnRequest)).toEqual([
      { isGrouped: true, kind: "message", status: "pending" },
      { isGrouped: true, kind: "message", status: "pending" },
    ]);
  });

  it("uses the base id for the first visible grouped turn request", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const req = f.clientTurnRequested({
      initiator: "user",
      target: { kind: "new-turn" },
      text: "Visible",
      input: [
        { type: "text", text: "Hidden", mentions: [], visibility: "agent-only" },
        { type: "text", text: "Visible", mentions: [] },
      ],
      inputGroups: [
        [{ type: "text", text: "Hidden", mentions: [], visibility: "agent-only" }],
        [{ type: "text", text: "Visible", mentions: [] }],
      ],
    });
    const rows = parseUsers(req);

    expect(rows.map((r) => ({ id: r.id, text: r.text }))).toEqual([
      { id: `thread-1:user-seed:${req.seq}`, text: "Visible" },
    ]);
  });

  it("populates initiator, senderThreadId, and turnRequest for agent-initiated messages", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const agentText = "[message from thread:thr_sender]\n\nHi";
    const row = parseUsers(
      f.clientTurnRequested({
        initiator: "agent",
        senderThreadId: SENDER_THREAD_ID,
        target: { kind: "new-turn" },
        text: agentText,
      }),
    )[0];

    expect(row).toMatchObject({
      initiator: "agent",
      senderThreadId: SENDER_THREAD_ID,
      turnRequest: { isGrouped: false, kind: "message", status: "pending" },
      text: agentText,
    });
  });

  it.each([
    "[bb message from thread:thr_legacy; reply later]\n\nLegacy handoff",
    "[message from thread:thr_legacy]\n\nLegacy handoff",
  ])("recovers agent attribution from a cross-thread envelope: %s", (text) => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const row = parseUsers(
      f.clientTurnRequested({
        initiator: "user",
        senderThreadId: null,
        target: { kind: "new-turn" },
        text,
      }),
    )[0];

    expect(row).toMatchObject({
      initiator: "agent",
      senderThreadId: "thr_legacy",
      text,
    });
  });

  it("populates initiator for system-initiated messages with a turnRequest", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const row = parseUsers(
      f.clientTurnRequested({
        initiator: "system",
        senderThreadId: null,
        target: { kind: "new-turn" },
        text: "[bb system] Maintenance notice.",
      }),
    )[0];

    expect(row).toMatchObject({
      initiator: "system",
      senderThreadId: null,
      turnRequest: { isGrouped: false, kind: "message", status: "pending" },
    });
  });

  it("preserves mentions for system-initiated messages", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const mentionText = "@thread:thr_child";
    const text = `[bb system]\n\n${mentionText} needs help.`;
    const mentionStart = "[bb system]\n\n".length;
    const mention: PromptTextMention = {
      start: mentionStart,
      end: mentionStart + mentionText.length,
      resource: {
        kind: "thread",
        label: "Backend cleanup",
        projectId: "proj_alpha",
        threadId: "thr_child",
      },
    };
    const row = parseUsers(
      f.clientTurnRequested({
        initiator: "system",
        senderThreadId: null,
        target: { kind: "new-turn" },
        text,
        input: [{ type: "text", text, mentions: [mention] }],
      }),
    )[0];

    expect(row).toMatchObject({ initiator: "system", text });
    expect(row?.mentions).toEqual([mention]);
  });

  it("treats steers as steer requests regardless of initiator", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const cases = [
      f.clientTurnRequested({
        initiator: "user",
        target: { kind: "auto", expectedTurnId: "turn-1" },
        text: "Mid-turn steer",
      }),
      f.clientTurnRequested({
        initiator: "agent",
        senderThreadId: SENDER_THREAD_ID,
        target: { kind: "auto", expectedTurnId: "turn-1" },
        text: AGENT_STEER_TEXT,
      }),
      f.clientTurnRequested({
        initiator: "system",
        senderThreadId: null,
        target: { kind: "auto", expectedTurnId: "turn-1" },
        text: "[bb system] Mid-turn nudge",
      }),
    ];
    for (const req of cases) {
      const accepted = acceptedClientRequest();
      expect(parsePendingSteers(req)[0]).toMatchObject({
        turnRequest: { isGrouped: false, kind: "steer", status: "pending" },
        sourceSeqStart: req.seq,
      });
      expect(parseAcceptedSteers(req, accepted)[0]).toMatchObject({
        turnRequest: { isGrouped: false, kind: "steer", status: "accepted" },
        sourceSeqStart: accepted.meta.seq,
      });
      expect(parseUsers(req)).toEqual([]);
    }
  });

  it("splits grouped steers into separate pending and accepted user messages", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const req = f.clientTurnRequested({
      initiator: "user",
      target: { kind: "auto", expectedTurnId: "turn-1" },
      text: "flattened",
      inputGroups: [
        [{ type: "text", text: "First grouped steer", mentions: [] }],
        [{ type: "text", text: "Second grouped steer", mentions: [] }],
      ],
    });
    const accepted = acceptedClientRequest();

    expect(
      parsePendingSteers(req).map((r) => ({
        id: r.id,
        text: r.text,
        turnRequest: r.turnRequest,
      })),
    ).toEqual([
      {
        id: "thread-1:user-seed:1",
        text: "First grouped steer",
        turnRequest: { isGrouped: true, kind: "steer", status: "pending" },
      },
      {
        id: "thread-1:user-seed:1-1",
        text: "Second grouped steer",
        turnRequest: { isGrouped: true, kind: "steer", status: "pending" },
      },
    ]);
    expect(
      parseAcceptedSteers(req, accepted).map((r) => ({
        id: r.id,
        sourceSeqStart: r.sourceSeqStart,
        text: r.text,
        turnRequest: r.turnRequest,
      })),
    ).toEqual([
      {
        id: "thread-1:user-seed:1",
        sourceSeqStart: accepted.meta.seq,
        text: "First grouped steer",
        turnRequest: { isGrouped: true, kind: "steer", status: "accepted" },
      },
      {
        id: "thread-1:user-seed:1-1",
        sourceSeqStart: accepted.meta.seq,
        text: "Second grouped steer",
        turnRequest: { isGrouped: true, kind: "steer", status: "accepted" },
      },
    ]);
  });

  it("uses visible grouped steer order when assigning ids", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const req = f.clientTurnRequested({
      initiator: "user",
      target: { kind: "auto", expectedTurnId: "turn-1" },
      text: "Visible steer\n\nSecond visible steer",
      inputGroups: [
        [{ type: "text", text: "Hidden", mentions: [], visibility: "agent-only" }],
        [{ type: "text", text: "Visible steer", mentions: [] }],
        [{ type: "text", text: "Second visible steer", mentions: [] }],
      ],
    });
    const accepted = acceptedClientRequest();

    expect(
      parsePendingSteers(req).map((r) => ({ id: r.id, text: r.text })),
    ).toEqual([
      { id: "thread-1:user-seed:1", text: "Visible steer" },
      { id: "thread-1:user-seed:1-1", text: "Second visible steer" },
    ]);
    expect(
      parseAcceptedSteers(req, accepted).map((r) => ({ id: r.id, text: r.text })),
    ).toEqual([
      { id: "thread-1:user-seed:1", text: "Visible steer" },
      { id: "thread-1:user-seed:1-1", text: "Second visible steer" },
    ]);
  });

  it("renders a steer accepted by a different turn as a message", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const req = f.clientTurnRequested({
      initiator: "user",
      target: { kind: "auto", expectedTurnId: "turn-1" },
      text: "Mid-turn steer",
    });
    const accepted = acceptedClientRequest("turn-2");

    expect(parseAcceptedSteers(req, accepted)).toEqual([]);
    expect(parseUsers(req, accepted)[0]).toMatchObject({
      turnId: "turn-2",
      sourceSeqStart: req.seq,
      text: "Mid-turn steer",
      turnRequest: { isGrouped: false, kind: "message", status: "accepted" },
    });
  });

  it("renders an explicit steer without an expected turn as a message", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const req = f.clientTurnRequested({
      initiator: "user",
      target: { kind: "steer", expectedTurnId: null },
      text: "Fallback message",
    });

    expect(parsePendingSteers(req)).toEqual([]);
    expect(parseUsers(req)[0]).toMatchObject({
      text: "Fallback message",
      turnRequest: { isGrouped: false, kind: "message", status: "pending" },
    });
  });

  it("renders system-originated turns as user messages", () => {
    const f = createTimelineEventFactory({ threadId: "thread-1" });
    const req = f.clientTurnRequested({
      initiator: "system",
      senderThreadId: null,
      target: { kind: "new-turn" },
      text: "[bb system] Maintenance notice.",
    });

    expect(parseUsers(req)[0]).toMatchObject({
      initiator: "system",
      text: "[bb system] Maintenance notice.",
      turnRequest: { isGrouped: false, kind: "message", status: "pending" },
    });
  });
});
