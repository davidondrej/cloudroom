import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  resolveNotification,
  type Interaction,
  type PendingEvents,
  type Thread,
} from "./rules.js";

const question = (prompt: string) =>
  ({
    status: "pending",
    payload: {
      kind: "user_question",
      questions: [{ id: "q", prompt, multiSelect: false, allowFreeText: true }],
    },
  }) as unknown as Interaction;

const thread = (overrides: Partial<Thread> = {}): Thread =>
  makeThreadResponse({
    id: "thread-1",
    status: "idle",
    title: "Fix the flaky test",
    latestAttentionAt: 100,
    lastReadAt: null,
    ...overrides,
  });
const finished: PendingEvents = { bodies: { finished: "Done" }, eventAt: 100 };
const failed: PendingEvents = { bodies: { error: "Exit 1" }, eventAt: 100 };

describe("resolveNotification", () => {
  it("notifies an unread finished turn with a trimmed title and body", () => {
    expect(
      resolveNotification(
        thread({ title: "x".repeat(90) }),
        { bodies: { finished: "y".repeat(200) }, eventAt: 100 },
        null,
      ),
    ).toEqual({ title: `${"x".repeat(79)}…`, body: `${"y".repeat(179)}…` });
    expect(
      resolveNotification(
        thread({ title: null, titleFallback: null }),
        finished,
        null,
      )?.title,
    ).toBe("Thread thread-1");
  });

  it.each([
    ["deleted threads", thread({ deletedAt: 1 }), finished],
    ["archived threads", thread({ archivedAt: 1 }), failed],
    [
      "hidden threads",
      thread({ visibility: "hidden", status: "error" }),
      failed,
    ],
    ["read threads", thread({ status: "error", lastReadAt: 200 }), failed],
    [
      "imported chats",
      thread({ lastReadAt: 100 }),
      { ...finished, eventAt: 150 },
    ],
    ["resumed threads", thread({ status: "active" }), finished],
    ["recovered threads", thread({ status: "idle" }), failed],
  ])("skips %s", (_name, current, events) => {
    expect(resolveNotification(current, events, null)).toBeNull();
  });

  it("prefers an open question, then an error, then a finished turn", () => {
    const all: PendingEvents = {
      bodies: { finished: "Done", error: "Exit 1", question: "Old" },
      eventAt: 100,
    };
    const errored = thread({ status: "error" });
    expect(
      resolveNotification(errored, all, question("Ship it?\nMore")),
    ).toMatchObject({ body: "Ship it?" });
    expect(resolveNotification(errored, all, null)).toMatchObject({
      body: "Exit 1",
    });
    expect(resolveNotification(thread(), all, null)).toMatchObject({
      body: "Done",
    });
  });
});
