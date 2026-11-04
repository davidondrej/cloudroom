import {
  deleteQueuedThreadMessage,
  getThread,
  listQueuedThreadMessages,
} from "@cloudroom/db";
import type { PromptInput } from "@cloudroom/domain";
import type {
  SendMessageRequest,
  SendMessageResponse,
} from "@cloudroom/server-contract";
import { afterEach, expect, it, vi } from "vitest";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import {
  sendNextQueuedMessageIfPresent as drain,
  sendQueuedMessageNow,
} from "../../src/services/threads/queued-messages.js";
import {
  REPEATED_MESSAGE_LIMIT as LIMIT,
  REPEATED_MESSAGE_WINDOW_MS as WINDOW,
} from "../../src/services/threads/repeated-message-guard.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { retryFailedTurn } from "../../src/services/threads/turn-retry.js";
import { textInput } from "../helpers/prompt-input.js";
import * as seed from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

// Repeat guard (#264), driven through the real `tell` send path.
type H = TestAppHarness;
type Extra = Partial<SendMessageRequest>;
const TEXT = "keep going";
const HELD = "repeated-message";
const P = "provider-repeat";

function seedIdleThread(h: H): string {
  const environment = { path: "/tmp/repeat", status: "ready" as const };
  const { thread } = seed.seedThreadFixture(h, { environment });
  const { environmentId, id: threadId } = thread;
  const runtime = { environmentId: environmentId!, providerThreadId: P };
  seed.seedThreadRuntimeState(h.deps, { ...runtime, threadId });
  return threadId;
}

/** One send; a turn it starts keeps running. */
function send(h: H, id: string, extra: Extra = {}) {
  const base = { input: textInput(TEXT), mode: "queue-if-active" as const };
  const payload = { ...base, ...extra };
  return acceptThreadSendRequest(h.deps, { payload, thread: thread(h, id) });
}
const thread = (h: H, id: string) => getThread(h.db, id)!;
const cards = (h: H, id: string) => listQueuedThreadMessages(h.db, id);

function finish(h: H, id: string, failed = false) {
  const type = failed ? "run.failed" : "run.succeeded";
  applyLoggedThreadLifecycleEvent(h.deps, { event: { type }, threadId: id });
}

const outcome = (r: SendMessageResponse) =>
  r.delivery === "queued" ? r.queuedMessage.waitingOn?.kind : r.delivery;
const sent = (n: number) => Array<string>(n).fill("sent");

/** `tell` n times, each turn finishing before the next; returns outcomes. */
async function tell(h: H, id: string, n = 1, extra: Extra = {}) {
  const results = [];
  for (let i = 0; i < n; i += 1) {
    results.push(outcome(await send(h, id, extra)));
    if (thread(h, id).status === "active") finish(h, id);
  }
  return results;
}

afterEach(() => vi.restoreAllMocks());

it("holds after a run, joins only exact copies, until the card is gone", async () => {
  await withTestHarness(async (h) => {
    const id = seedIdleThread(h);
    expect(await tell(h, id, LIMIT)).toEqual(sent(LIMIT));
    expect(await tell(h, id)).toEqual([HELD]);
    expect(thread(h, id).status).toBe("idle");

    // Other attachments or execution make a card of their own, never dropped.
    const file = (path: string): Extra => ({
      input: [...textInput(TEXT), { type: "localFile", path } as PromptInput],
    });
    const cases: [Extra, number][] = [
      [{}, 1],
      [file("/a.txt"), 2],
      [file("/b.txt"), 3],
      [{ reasoningLevel: "high" }, 4],
    ];
    for (const [extra, count] of cases) {
      expect(await tell(h, id, 1, extra)).toEqual([HELD]);
      expect(cards(h, id)).toHaveLength(count);
    }
    // An exact duplicate answers with its own held card's id.
    const dup = await send(h, id, file("/b.txt"));
    const dupId = dup.delivery === "queued" ? dup.queuedMessage.id : null;
    expect(dupId).toBe(cards(h, id)[2]!.id);
    expect(cards(h, id)).toHaveLength(4);

    const queuedMessageId = cards(h, id)[1]!.id;
    const now = { mode: "auto" as const, queuedMessageId, threadId: id };
    await expect(sendQueuedMessageNow(h.deps, now)).resolves.toEqual({
      delivery: "sent",
    });
    expect(thread(h, id).status).toBe("active");
    finish(h, id);

    // A held same-text card keeps holding past the window, until deleted.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + WINDOW + 1);
    expect(await tell(h, id)).toEqual([HELD]);
    expect(cards(h, id)).toHaveLength(3);
    for (const row of cards(h, id)) {
      deleteQueuedThreadMessage(h.db, h.deps.hub, row.id);
    }
    expect(await tell(h, id)).toEqual(sent(1));
  });
});

it("holds a repeat that queued behind a busy turn when it drains", async () => {
  await withTestHarness(async (h) => {
    const id = seedIdleThread(h);
    await tell(h, id, LIMIT - 1);
    await send(h, id);
    expect(outcome(await send(h, id))).toBe("thread-busy");
    finish(h, id);

    await drain(h.deps, { threadId: id });
    expect(thread(h, id).status).toBe("idle");
    const waitingOn = JSON.stringify({ kind: HELD });
    expect(cards(h, id)).toMatchObject([{ waitingOn }]);
    await expect(drain(h.deps, { threadId: id })).resolves.toBe(false);
  });
});

it("neither counts nor breaks the run on steers (even 50) or retries", async () => {
  await withTestHarness(async (h) => {
    const id = seedIdleThread(h);
    await send(h, id);
    const { environmentId } = thread(h, id);
    const turn = { providerThreadId: P, threadId: id, turnId: "turn-1" };
    seed.seedTurnStarted(h.deps, { ...turn, environmentId: environmentId! });
    for (let i = 0; i < 50; i += 1) {
      expect(outcome(await send(h, id, { mode: "steer" }))).toBe("sent");
    }
    finish(h, id);
    expect(await tell(h, id, LIMIT - 2)).toEqual(sent(LIMIT - 2));

    await send(h, id);
    finish(h, id, true);
    const request = { turnRequestId: null, sendAt: null, reason: "Limited" };
    const retry = retryFailedTurn(h.deps, { thread: thread(h, id), request });
    await expect(retry).resolves.toMatchObject({ delivery: "sent" });
    finish(h, id);
    expect(await tell(h, id)).toEqual([HELD]);
  });
});

it("does not hold after other input, outside the window, or for Loops", async () => {
  await withTestHarness(async (h) => {
    const id = seedIdleThread(h);
    await tell(h, id, LIMIT - 1);
    await tell(h, id, 1, { input: textInput("something else") });
    expect(await tell(h, id)).toEqual(sent(1));

    const old = { input: textInput("old repeat") };
    vi.spyOn(Date, "now").mockReturnValue(Date.now() - WINDOW - 1);
    await tell(h, id, LIMIT, old);
    vi.restoreAllMocks();
    expect(await tell(h, id, 1, old)).toEqual(sent(1));

    const loop = { input: textInput("[room-cli automation due:a1] Check CI") };
    expect(await tell(h, id, LIMIT + 1, loop)).toEqual(sent(LIMIT + 1));
  });
});
