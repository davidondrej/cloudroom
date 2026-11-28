import { getThread } from "@cloudroom/db";
import { encodeClientTurnRequestIdNumber, threadScope, turnScope } from "@cloudroom/domain";
import { describe, expect, it, vi } from "vitest";

const model = vi.hoisted(() => ({ answer: (_prompt: string): unknown => null, settle: () => {} }));
vi.mock("../../../src/services/ai/inference.js", async (original) => ({
  ...(await original<object>()),
  inferenceCompleteWithFallback: async (_deps: unknown, { prompt }: { prompt: string }) => {
    setImmediate(model.settle); // the write after the answer is synchronous
    return model.answer(prompt);
  },
}));

import { writeUiPreference } from "../../../src/services/system/ui-preferences.js";
import { applyLoggedThreadLifecycleEvent } from "../../../src/services/threads/lifecycle-outcome.js";
import { installThreadPurpose } from "../../../src/services/threads/thread-purpose.js";
import { seedEvent, seedThreadFixture } from "../../helpers/seed.js";
import { withTestHarness } from "../../helpers/test-app.js";

// #2437: a reply whose note refresh failed is not lost when later turns bring nothing new.
describe("thread purpose", () => {
  const run = (script: (turn: Turn) => Promise<void>) =>
    withTestHarness(async (harness) => {
      const deps = harness.deps;
      writeUiPreference(deps, { expectedRevision: 0, key: "threadPurpose.model", value: "test-model" });
      const { thread } = seedThreadFixture(harness);
      const stop = installThreadPurpose(deps as never);
      let sequence = 10;
      const event = (turnId: string, type: string, data: object, scope = turnScope(turnId)) =>
        seedEvent(deps, { threadId: thread.id, providerThreadId: "p", sequence: ++sequence, type, scope, data } as never);
      await script(async (n, reply, { fail = false, initiator = "user", worker, nestedAfter }: TurnOptions = {}) => {
        const turnId = `turn-${n}`;
        event(turnId, "client/turn/requested", {
          direction: "outbound", requestId: encodeClientTurnRequestIdNumber({ value: n }), initiator, senderThreadId: null,
          source: "tell", input: [{ type: "text", text: `message ${n}` }], target: { kind: "new-turn" },
          request: { method: "turn/start", params: {} },
          execution: { model: "gpt-5", serviceTier: "default", reasoningLevel: "medium", permissionMode: "full", source: "client/turn/requested" },
        }, threadScope());
        event(turnId, "turn/started", { providerThreadId: "p" });
        applyLoggedThreadLifecycleEvent(deps, { threadId: thread.id, event: { type: "run.started" } });
        if (worker) {
          event(`worker-${n}`, "turn/started", { providerThreadId: "p", parentToolCallId: "call-1" });
          event(`worker-${n}`, "item/completed", { item: { type: "agentMessage", id: "worker", text: worker, parentToolCallId: "call-1" } });
          event(`worker-${n}`, "turn/completed", { status: "completed" });
        }
        event(turnId, "item/completed", { item: { type: "agentMessage", id: `message-${n}`, text: reply } });
        if (nestedAfter) event(turnId, "item/completed", { item: { type: "agentMessage", id: "nested", text: nestedAfter, parentToolCallId: "call-2" } });
        event(turnId, "turn/completed", { status: "completed" });
        model.answer = fail ? () => { throw new Error("model timed out"); } : answer;
        const written = new Promise<void>((resolve) => { model.settle = resolve; });
        applyLoggedThreadLifecycleEvent(deps, { threadId: thread.id, event: { type: "run.succeeded" } });
        await written;
      });
      const note = getThread(deps.db, thread.id)?.purpose;
      stop();
      return note;
    });
  // A stand-in model that follows the prompt: done once it reads the amendment was pushed, else it keeps the note.
  const goal = "Fixing the release notes.";
  const answer = (prompt: string) =>
    /amendment is pushed|State: Pushed/u.test(prompt)
      ? { goal, state: "Pushed to GitHub.", percent: 100 }
      : { goal, state: "Retrying the amendment.", percent: 50 };

  it.each(["", " \n ", "\u00a0", "\u0085"])("still sees a reply its refresh missed, past blank turns (%j)", async (blank) => {
    const note = await run(async (turn) => {
      await turn(1, "Retrying the amendment.");
      await turn(2, "The amendment is pushed.", { fail: true });
      for (const n of [3, 4, 5]) await turn(n, blank, { fail: true, initiator: "system" }); // turns after child notices
      await turn(6, "Loop pass finished. Nothing new to report.");
    });
    expect(note).toMatchObject({ text: `${goal} Pushed to GitHub.`, percent: 100 });
  });

  it("still sees a reply a newer nested item in its turn followed", async () => {
    const note = await run(async (turn) => {
      await turn(1, "Retrying the amendment.");
      await turn(2, "The amendment is pushed.", { fail: true, nestedAfter: "Worker finished." });
      await turn(3, "Loop pass finished. Nothing new to report.");
    });
    expect(note).toMatchObject({ text: `${goal} Pushed to GitHub.`, percent: 100 });
  });

  it("leaves out a nested worker's reply", async () => {
    const note = await run(async (turn) => {
      await turn(1, "Retrying the amendment.");
      await turn(2, "Waiting on the worker.", { fail: true, worker: "The amendment is pushed." });
      await turn(3, "Loop pass finished. Nothing new to report.");
    });
    expect(note).toMatchObject({ text: `${goal} Retrying the amendment.`, percent: 50 });
  });
});

type TurnOptions = { fail?: boolean; initiator?: "user" | "system"; worker?: string; nestedAfter?: string };
type Turn = (n: number, reply: string, options?: TurnOptions) => Promise<void>;
