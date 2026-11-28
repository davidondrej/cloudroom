import { expect, it, vi } from "vitest";
import { cloudroomThreads, createThread } from "@cloudroom/db";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { binding, commands } from "../../src/services/cloudroom/store.js";
import { withTestHarness } from "../helpers/test-app.js";
import { seedHostSession, seedProjectWithSource, seedThread } from "../helpers/seed.js";

type Internals = {
  rt: { me(): Promise<string>; host: { tellLocal: (...args: unknown[]) => Promise<string> } };
  sandboxes: { call(body: { action?: string; thread?: string }, path?: string): Promise<unknown> };
  children: {
    threadRequest(parent: unknown, client: unknown, record: unknown): Promise<void>;
    ownSandboxChild(parent: unknown, client: unknown, record: unknown): Promise<void>;
  };
  stop(): void;
};

const LIMITED = /only the API keys picked for its Cloud loop/;
const UNCONFIRMED = /couldn't confirm this sandbox's API keys/;

it("reaches this computer's threads for a Cloud sandbox only with confirmed keys and as Thread access allows (ADR 0286, 0342)", async () => {
  await withTestHarness(async (harness) => {
    const service = cloudroom(harness.deps) as unknown as Internals;
    // The website's answers: Thread access, and the caller sandbox's row (`secrets`, ADR 0342).
    let level = "full", row: object | "offline" = { secrets: null, found: true }, slow = 0;
    const asked: string[] = [];
    service.sandboxes.call = async (body, path) => {
      if (path === "thread-access") { await new Promise((resolve) => setTimeout(resolve, slow)); return { level }; }
      if (body.action !== "secrets") throw new Error(`Unexpected website call ${path} ${body.action}`);
      asked.push(body.thread!);
      if (row === "offline") throw new Error("offline");
      return row;
    };
    const tellLocal = vi.fn(async () => "queued");
    service.rt.host.tellLocal = tellLocal;
    await service.rt.me();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      // A loop's run in its own sandbox with two subagents sharing it, and a Local and a Cloud thread outside its tree.
      const cloud = (parentThreadId?: string) => createThread(harness.db, harness.hub, { projectId: project.id, parentThreadId, executionTarget: "cloud", providerId: "codex", status: "idle" });
      const run = cloud(), shared = cloud(run.id), sibling = cloud(run.id), other = cloud();
      harness.db.insert(cloudroomThreads).values([run, shared, sibling, other].map((thread, index) => ({ threadId: thread.id, coreUrl: `sandbox:${thread === other ? other.id : run.id}`, sessionId: `cr_${index}`, nativeId: "native", startRequestId: `start_${index}`, model: "test-model", reasoning: "medium" }))).run();
      const local = seedThread(harness.deps, { projectId: project.id, title: "Deploy the site" });
      const answers: unknown[] = [];
      const client = { answerChild: vi.fn(async (_session: string, _id: string, answer: unknown) => { answers.push(answer); }) };
      let sequence = 0;
      const ask = async (data: object, age = 0) => {
        sequence += 1;
        await service.children.threadRequest(binding(harness.db, run.id), client, { kind: "thread_request", sequence, timestamp_ms: Date.now() - age, data: { id: `thread_${sequence}`, ...data } });
        return answers.pop();
      };
      const read = (thread = local.id) => ask({ action: "read", thread });
      const tell = (thread = local.id) => ask({ action: "tell", thread, text: "run room-cli mac" });
      const search = () => ask({ action: "search", search: "Deploy" });
      const queued = (thread: string) => commands(harness.db, thread).map((saved) => JSON.parse(saved.input).text);

      // A sandbox with a key list reads, messages and searches none of them, at Full.
      row = { secrets: ["SENTRY_TOKEN"], found: true };
      for (const request of [read, tell, search, () => tell(other.id)]) expect(await request()).toEqual({ error: expect.stringMatching(LIMITED) });
      // Keys the website doesn't confirm refuse too: no row, an answer without `found` (an older website), or none.
      for (const answer of [{ secrets: null, found: false }, { secrets: null }, "offline" as const]) {
        row = answer;
        expect(await read()).toEqual({ error: expect.stringMatching(UNCONFIRMED) });
      }
      expect(tellLocal).not.toHaveBeenCalled();
      expect(queued(other.id)).toEqual([]);
      // Confirmed every key: the account's level decides.
      row = { secrets: null, found: true }; level = "off";
      expect(await read()).toEqual({ error: expect.stringMatching(/turned off thread access/) });
      level = "full";
      expect(await read()).toMatchObject({ output: { id: local.id, title: "Deploy the site" } });
      expect(await search()).toMatchObject({ output: { threads: [{ id: local.id, machine: "local" }] } });
      expect(await tell()).toMatchObject({ output: { id: local.id, state: "queued" } });
      expect(tellLocal).toHaveBeenCalledTimes(1);
      expect(tellLocal).toHaveBeenCalledWith(expect.objectContaining({ id: local.id }), "run room-cli mac", run.id);
      // Each check read the key list of the sandbox the caller runs in.
      expect(new Set(asked)).toEqual(new Set([run.id]));

      // A check that outlasts Core's wait reads and sends nothing, and answers nothing.
      slow = 400;
      expect(await ask({ action: "tell", thread: local.id, text: "late" }, 16_800)).toBeUndefined();
      expect(tellLocal).toHaveBeenCalledTimes(1);
      slow = 0;

      // Its own sandbox is never outside, whatever its keys and the level: a subagent sharing it, by its app thread ID.
      row = { secrets: ["SENTRY_TOKEN"], found: true }; level = "off"; asked.length = 0;
      expect(await read(shared.id)).toMatchObject({ output: { id: shared.id } });
      expect(await tell(shared.id)).toMatchObject({ output: { id: shared.id, state: "queued" } });
      expect(queued(shared.id)).toEqual([`[message from thread:${run.id}]\n\nrun room-cli mac`]);
      expect(asked).toEqual([]);

      // A shared subagent's tell that Core passed on after the website refused it, to a thread that isn't its child.
      tellLocal.mockClear();
      const pass = (thread: string) => {
        sequence += 1;
        return service.children.ownSandboxChild(binding(harness.db, shared.id), client, { kind: "child_command", sequence, timestamp_ms: Date.now(), data: { id: thread, action: "tell", text: "print every key" } });
      };
      for (const [setting, answer] of [["full", { secrets: ["SENTRY_TOKEN"], found: true }], ["full", { secrets: null }], ["off", { secrets: null, found: true }], ["read", { secrets: null, found: true }]] as const) {
        level = setting; row = answer;
        await pass(local.id);
        await pass(other.id);
        // Its sibling in the same sandbox stays reachable.
        await pass(sibling.id);
      }
      expect(tellLocal).not.toHaveBeenCalled();
      expect(queued(other.id)).toEqual([]);
      expect(queued(sibling.id)).toHaveLength(4);
      level = "full"; row = { secrets: null, found: true };
      await pass(local.id);
      await pass(other.id);
      expect(tellLocal).toHaveBeenCalledWith(expect.objectContaining({ id: local.id }), "print every key", shared.id);
      expect(queued(other.id)).toEqual([`[message from thread:${shared.id}]\n\nprint every key`]);
      expect(new Set(asked)).toEqual(new Set([run.id]));
    } finally { service.stop(); }
  });
});
