import { describe, expect, it, vi } from "vitest";
import { threadScope, type PromptInput } from "@cloudroom/domain";
import { noopNotifier } from "../../src/notifier.js";
import { insertEvents } from "../../src/data/events.js";
import {
  claimNextQueuedThreadMessage,
  claimQueuedThreadMessage,
  createQueuedThreadMessage,
  deleteClaimedQueuedThreadMessageInTransaction,
  deleteQueuedThreadMessage,
  getQueuedThreadMessage,
  listIdleThreadsWithQueuedMessages,
  listQueuedThreadMessages,
  releaseQueuedMessageClaim,
  releaseStaleQueuedMessageClaims,
  reorderQueuedThreadMessage,
  updateQueuedThreadMessage,
} from "../../src/data/queued-thread-messages.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function textInput(text: string): PromptInput[] {
  return [{ type: "text", text, mentions: [] }];
}

const defaultInput = textInput("hello");
const altInput = textInput("world");

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  return { db, project, thread };
}

describe("queued thread messages", () => {
  it("creates a queued message", () => {
    const { db, thread } = setup();
    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(queuedMessage.id).toMatch(/^qmsg_/);
    expect(queuedMessage.threadId).toBe(thread.id);
    expect(queuedMessage.content).toBe(JSON.stringify(defaultInput));
    expect(queuedMessage.model).toBe("gpt-5");
    expect(queuedMessage.serviceTier).toBe("default");
  });

  it("gets a queued message by ID", () => {
    const { db, thread } = setup();
    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const fetched = getQueuedThreadMessage(db, queuedMessage.id);
    expect(fetched?.id).toBe(queuedMessage.id);
    expect(getQueuedThreadMessage(db, "qmsg_nonexistent")).toBeNull();
  });

  it("lists queued messages by thread", () => {
    const { db, thread } = setup();
    createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(listQueuedThreadMessages(db, thread.id)).toHaveLength(2);
  });

  it("lists an idle thread waiting for its turn to start", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });
    createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "turn-starting" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(
      listIdleThreadsWithQueuedMessages(db).map((row) => row.threadId),
    ).toContain(thread.id);
  });

  it("updates queued message content without changing its identity or position", () => {
    const { db, thread } = setup();
    const first = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const second = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const before = getQueuedThreadMessage(db, first.id);

    const result = updateQueuedThreadMessage(db, noopNotifier, {
      content: textInput("edited in place"),
      expectedUpdatedAt: before?.updatedAt ?? -1,
      id: first.id,
      threadId: thread.id,
    });

    expect(result.kind).toBe("updated");
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.id),
    ).toEqual([first.id, second.id]);
    expect(getQueuedThreadMessage(db, first.id)).toMatchObject({
      content: JSON.stringify(textInput("edited in place")),
      createdAt: before?.createdAt,
      id: first.id,
      model: before?.model,
      permissionMode: before?.permissionMode,
      reasoningLevel: before?.reasoningLevel,
      serviceTier: before?.serviceTier,
      sortKey: before?.sortKey,
    });
  });

  it("rejects a second update based on the same queued message version", () => {
    const { db, thread } = setup();
    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(
      updateQueuedThreadMessage(db, noopNotifier, {
        content: textInput("first edit"),
        expectedUpdatedAt: queuedMessage.updatedAt,
        id: queuedMessage.id,
        threadId: thread.id,
      }).kind,
    ).toBe("updated");
    expect(
      updateQueuedThreadMessage(db, noopNotifier, {
        content: textInput("stale edit"),
        expectedUpdatedAt: queuedMessage.updatedAt,
        id: queuedMessage.id,
        threadId: thread.id,
      }),
    ).toEqual({ kind: "stale" });
    expect(getQueuedThreadMessage(db, queuedMessage.id)?.content).toBe(
      JSON.stringify(textInput("first edit")),
    );
  });

  it("advances updatedAt when an update occurs within the same millisecond", () => {
    const fixedNow = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    try {
      const { db, thread } = setup();
      const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });

      const result = updateQueuedThreadMessage(db, noopNotifier, {
        content: altInput,
        expectedUpdatedAt: queuedMessage.updatedAt,
        id: queuedMessage.id,
        threadId: thread.id,
      });

      expect(result).toMatchObject({
        kind: "updated",
        queuedMessage: { updatedAt: fixedNow + 1 },
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("does not update a queued message that is already claimed for sending", () => {
    const { db, thread } = setup();
    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    claimQueuedThreadMessage(db, noopNotifier, queuedMessage.id);

    expect(
      updateQueuedThreadMessage(db, noopNotifier, {
        content: altInput,
        expectedUpdatedAt: queuedMessage.updatedAt,
        id: queuedMessage.id,
        threadId: thread.id,
      }),
    ).toEqual({ kind: "claimed" });
    expect(getQueuedThreadMessage(db, queuedMessage.id)?.content).toBe(
      JSON.stringify(defaultInput),
    );
  });

  it("deletes a queued message", () => {
    const { db, thread } = setup();
    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(deleteQueuedThreadMessage(db, noopNotifier, queuedMessage.id)).toBe(
      true,
    );
    expect(listQueuedThreadMessages(db, thread.id)).toHaveLength(0);
    expect(deleteQueuedThreadMessage(db, noopNotifier, queuedMessage.id)).toBe(
      false,
    );
  });

  it("claims a queued message and hides it from the queue until the claim is released", () => {
    const { db, thread } = setup();
    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const claimedQueuedMessage = claimQueuedThreadMessage(
      db,
      noopNotifier,
      queuedMessage.id,
    );
    expect(claimedQueuedMessage?.id).toBe(queuedMessage.id);
    expect(claimedQueuedMessage?.claimToken).toMatch(/^qclaim_/);
    expect(listQueuedThreadMessages(db, thread.id)).toHaveLength(0);

    if (!claimedQueuedMessage) {
      throw new Error("Expected queued message claim");
    }
    expect(
      releaseQueuedMessageClaim(db, noopNotifier, {
        id: queuedMessage.id,
        claimToken: claimedQueuedMessage.claimToken,
      }),
    ).toBe(true);
    expect(listQueuedThreadMessages(db, thread.id)).toHaveLength(1);
  });

  it("does not release or consume a queued message claimed by another owner", () => {
    const { db, thread } = setup();
    const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const firstClaim = claimQueuedThreadMessage(
      db,
      noopNotifier,
      queuedMessage.id,
    );
    if (!firstClaim) {
      throw new Error("Expected first queued message claim");
    }
    expect(
      releaseQueuedMessageClaim(db, noopNotifier, {
        id: queuedMessage.id,
        claimToken: "qclaim_staleowner",
      }),
    ).toBe(false);
    expect(getQueuedThreadMessage(db, queuedMessage.id)?.claimToken).toBe(
      firstClaim.claimToken,
    );
    expect(
      db.transaction((tx) =>
        deleteClaimedQueuedThreadMessageInTransaction(tx, { id: queuedMessage.id, claimToken: "qclaim_staleowner" }),
      ),
    ).toBe(false);

    expect(
      releaseQueuedMessageClaim(db, noopNotifier, {
        id: queuedMessage.id,
        claimToken: firstClaim.claimToken,
      }),
    ).toBe(true);
    const secondClaim = claimQueuedThreadMessage(
      db,
      noopNotifier,
      queuedMessage.id,
    );
    if (!secondClaim) {
      throw new Error("Expected second queued message claim");
    }
    expect(secondClaim.claimToken).not.toBe(firstClaim.claimToken);
    expect(
      db.transaction((tx) =>
        deleteClaimedQueuedThreadMessageInTransaction(tx, { id: queuedMessage.id, claimToken: firstClaim.claimToken }),
      ),
    ).toBe(false);
    expect(getQueuedThreadMessage(db, queuedMessage.id)?.claimToken).toBe(
      secondClaim.claimToken,
    );
    expect(
      db.transaction((tx) =>
        deleteClaimedQueuedThreadMessageInTransaction(tx, { id: queuedMessage.id, claimToken: secondClaim.claimToken }),
      ),
    ).toBe(true);
    expect(getQueuedThreadMessage(db, queuedMessage.id)).toBeNull();
  });

  it("releases stale queued message claims", () => {
    const { db, thread } = setup();
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(1_000);
      const queuedMessage = createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });
      const claimedQueuedMessage = claimQueuedThreadMessage(
        db,
        noopNotifier,
        queuedMessage.id,
      );
      expect(claimedQueuedMessage?.claimedAt).toBe(1_000);
      expect(claimedQueuedMessage?.claimToken).toMatch(/^qclaim_/);
      expect(listQueuedThreadMessages(db, thread.id)).toHaveLength(0);

      nowSpy.mockReturnValue(10_000);
      expect(
        releaseStaleQueuedMessageClaims(db, noopNotifier, {
          claimedBefore: 5_000,
          protectedClaimTokens: [],
        }),
      ).toBe(1);
      expect(
        listQueuedThreadMessages(db, thread.id).map((row) => row.id),
      ).toEqual([queuedMessage.id]);
      expect(
        getQueuedThreadMessage(db, queuedMessage.id)?.claimToken,
      ).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not release stale queued message claims protected by a live owner", () => {
    const { db, thread } = setup();
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(1_000);
      const protectedQueuedMessage = createQueuedThreadMessage(
        db,
        noopNotifier,
        {
          threadId: thread.id,
          content: defaultInput,
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          waitingOn: null,
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
        },
      );
      const releasableQueuedMessage = createQueuedThreadMessage(
        db,
        noopNotifier,
        {
          threadId: thread.id,
          content: altInput,
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          waitingOn: null,
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
        },
      );
      const protectedClaim = claimQueuedThreadMessage(
        db,
        noopNotifier,
        protectedQueuedMessage.id,
      );
      const releasableClaim = claimQueuedThreadMessage(
        db,
        noopNotifier,
        releasableQueuedMessage.id,
      );
      if (!protectedClaim || !releasableClaim) {
        throw new Error("Expected queued message claims");
      }

      nowSpy.mockReturnValue(10_000);
      expect(
        releaseStaleQueuedMessageClaims(db, noopNotifier, {
          claimedBefore: 5_000,
          protectedClaimTokens: [protectedClaim.claimToken],
        }),
      ).toBe(1);

      expect(
        getQueuedThreadMessage(db, protectedQueuedMessage.id)?.claimToken,
      ).toBe(protectedClaim.claimToken);
      expect(
        getQueuedThreadMessage(db, releasableQueuedMessage.id)?.claimToken,
      ).toBeNull();
      expect(
        listQueuedThreadMessages(db, thread.id).map((row) => row.id),
      ).toEqual([releasableQueuedMessage.id]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("claims the oldest queued message first", () => {
    const { db, thread } = setup();
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValueOnce(1_000);
      const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        content: defaultInput,
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: { kind: "turn-starting" },
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });
      nowSpy.mockReturnValueOnce(2_000);
      const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
        threadId: thread.id,
        content: altInput,
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });

      const claimedQueuedMessage = claimNextQueuedThreadMessage(
        db,
        noopNotifier,
        thread.id,
      );
      expect(claimedQueuedMessage?.id).toBe(firstQueuedMessage.id);
      expect(
        listQueuedThreadMessages(db, thread.id).map(
          (queuedMessage) => queuedMessage.id,
        ),
      ).toEqual([secondQueuedMessage.id]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("pauses ordinary turn-end rows without pausing system notices", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });
    const ordinary = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "thread-busy" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const notice = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "thread-busy" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: {
        kind: "child-completed",
        subject: {
          kind: "thread",
          threadId: "thr_child",
          threadName: "Child",
        },
      },
    });
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/thread/interrupted",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ reason: "manual-stop" }),
      },
    ]);

    expect(
      listIdleThreadsWithQueuedMessages(db).map((row) => row.threadId),
    ).toContain(thread.id);
    expect(
      claimQueuedThreadMessage(db, noopNotifier, ordinary.id, {
        kind: "automatic",
        isEligible: () => true,
      }),
    ).toBeNull();
    expect(
      claimNextQueuedThreadMessage(db, noopNotifier, thread.id)?.id,
    ).toBe(notice.id);
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.id),
    ).toEqual([ordinary.id]);
  });

  it("lets a row the user asked for during the stop out of the manual-stop pause", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });
    const heldBack = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "thread-busy" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const askedForDuringStop = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "stopping" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/thread/interrupted",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ reason: "manual-stop" }),
      },
    ]);

    expect(
      listIdleThreadsWithQueuedMessages(db).map((row) => row.threadId),
    ).toContain(thread.id);
    expect(
      claimQueuedThreadMessage(db, noopNotifier, heldBack.id, {
        kind: "automatic",
        isEligible: () => true,
      }),
    ).toBeNull();
    expect(
      claimNextQueuedThreadMessage(db, noopNotifier, thread.id)?.id,
    ).toBe(askedForDuringStop.id);
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.id),
    ).toEqual([heldBack.id]);
  });

  it("keeps a paused thread off the idle drain when every row is an ordinary turn-end wait", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
    });
    createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "thread-busy" },
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "system/thread/interrupted",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ reason: "manual-stop" }),
      },
    ]);

    expect(
      listIdleThreadsWithQueuedMessages(db).map((row) => row.threadId),
    ).not.toContain(thread.id);
  });

  it("reorders queued messages to the front, middle, and end", () => {
    const { db, thread } = setup();
    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    const moveToFront = reorderQueuedThreadMessage({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      queuedMessageId: thirdQueuedMessage.id,
      previousQueuedMessageId: null,
      nextQueuedMessageId: firstQueuedMessage.id,
    });
    expect(moveToFront.kind).toBe("reordered");
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.id),
    ).toEqual([
      thirdQueuedMessage.id,
      firstQueuedMessage.id,
      secondQueuedMessage.id,
    ]);

    const moveToMiddle = reorderQueuedThreadMessage({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      queuedMessageId: secondQueuedMessage.id,
      previousQueuedMessageId: thirdQueuedMessage.id,
      nextQueuedMessageId: firstQueuedMessage.id,
    });
    expect(moveToMiddle.kind).toBe("reordered");
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.id),
    ).toEqual([
      thirdQueuedMessage.id,
      secondQueuedMessage.id,
      firstQueuedMessage.id,
    ]);

    const moveToEnd = reorderQueuedThreadMessage({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      queuedMessageId: thirdQueuedMessage.id,
      previousQueuedMessageId: firstQueuedMessage.id,
      nextQueuedMessageId: null,
    });
    expect(moveToEnd.kind).toBe("reordered");
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.id),
    ).toEqual([
      secondQueuedMessage.id,
      firstQueuedMessage.id,
      thirdQueuedMessage.id,
    ]);
  });

  it("claims the reordered first queued message", () => {
    const { db, thread } = setup();
    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: secondQueuedMessage.id,
        previousQueuedMessageId: null,
        nextQueuedMessageId: firstQueuedMessage.id,
      }).kind,
    ).toBe("reordered");

    const claimedQueuedMessage = claimNextQueuedThreadMessage(
      db,
      noopNotifier,
      thread.id,
    );
    expect(claimedQueuedMessage?.id).toBe(secondQueuedMessage.id);
    expect(
      listQueuedThreadMessages(db, thread.id).map((row) => row.id),
    ).toEqual([firstQueuedMessage.id]);
  });

  it("rejects reordering claimed, missing, cross-thread, and inverted neighbors", () => {
    const { db, thread } = setup();
    const otherThread = createThread(db, noopNotifier, {
      projectId: thread.projectId,
      providerId: "codex",
    });
    const firstQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const secondQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: altInput,
      model: "gpt-5",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const thirdQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: textInput("third"),
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const otherQueuedMessage = createQueuedThreadMessage(db, noopNotifier, {
      threadId: otherThread.id,
      content: defaultInput,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });

    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: "qmsg_missing",
        previousQueuedMessageId: null,
        nextQueuedMessageId: firstQueuedMessage.id,
      }).kind,
    ).toBe("not_found");
    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: thirdQueuedMessage.id,
        previousQueuedMessageId: otherQueuedMessage.id,
        nextQueuedMessageId: null,
      }).kind,
    ).toBe("stale_neighbor");
    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: firstQueuedMessage.id,
        previousQueuedMessageId: thirdQueuedMessage.id,
        nextQueuedMessageId: secondQueuedMessage.id,
      }).kind,
    ).toBe("invalid_neighbor_order");

    const claimedQueuedMessage = claimQueuedThreadMessage(
      db,
      noopNotifier,
      secondQueuedMessage.id,
    );
    if (!claimedQueuedMessage) {
      throw new Error("Expected queued message claim");
    }
    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: secondQueuedMessage.id,
        previousQueuedMessageId: null,
        nextQueuedMessageId: firstQueuedMessage.id,
      }).kind,
    ).toBe("claimed");
    expect(
      reorderQueuedThreadMessage({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        queuedMessageId: thirdQueuedMessage.id,
        previousQueuedMessageId: null,
        nextQueuedMessageId: secondQueuedMessage.id,
      }).kind,
    ).toBe("stale_neighbor");
  });
});
