import { eq } from "drizzle-orm";
import { CALLER_TOKEN_HEADER } from "@cloudroom/config/caller-proof";
import { createDeferredPromise } from "@cloudroom/test-helpers";
import { afterEach, expect, it, vi } from "vitest";
import {
  cloudroomCommands,
  cloudroomThreads,
  createThread,
  getThread,
} from "@cloudroom/db";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function archiveFixture(shared: boolean) {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const create = (parentThreadId?: string) =>
    createThread(harness.db, harness.hub, {
      projectId: project.id,
      parentThreadId,
      executionTarget: "cloud",
      providerId: "codex",
      status: "idle",
    });
  const parent = create(),
    child = create(parent.id);
  harness.db
    .insert(cloudroomThreads)
    .values(
      [parent, child].map((thread) => ({
        threadId: thread.id,
        coreUrl: `sandbox:${shared ? parent.id : thread.id}`,
        sessionId: "cr_" + thread.id,
        startRequestId: "first_" + thread.id,
        model: "test-model",
        reasoning: "medium",
      })),
    )
    .run();
  const service = cloudroom(harness.deps);
  const website = "http://127.0.0.1:12340";
  vi.spyOn(service.sandboxes, "account").mockResolvedValue({
    website,
    userId: "test",
    token: "fixture",
  });
  const post = (id: string, action: string) =>
    harness.app.request(`/api/v1/threads/${id}/${action}`, { method: "POST" });
  return { harness, service, parent, child, website, post };
}

it("checks each awake sandbox concurrently, drops cached addresses and cancels outstanding Core reads", async () => {
  const { harness, service, parent, child, website } =
    await archiveFixture(false);
  let awake = [parent, child],
    directoryReads = 0;
  const sessions: AbortSignal[] = [];
  let incomplete = false;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    if (input.startsWith(website)) {
      expect(JSON.parse(String(init.body)).action).toBe("awake");
      directoryReads++;
      return Response.json({
        sandboxes: awake.map((t) => ({
          thread: t.id,
          origin: "http://127.0.0.1:12341/" + t.id,
          token: "fixture",
        })),
      });
    }
    expect(input).toMatch(/\/v1\/sessions$/);
    if (incomplete) return Response.json({ total: 1001, sessions: [] });
    sessions.push(init.signal!);
    return new Promise<Response>((_, reject) =>
      init.signal!.addEventListener(
        "abort",
        () => reject(init.signal!.reason),
        { once: true },
      ),
    );
  });
  const read = (signal?: AbortSignal) =>
    harness.app.fetch(
      new Request(
        `http://localhost/api/v1/cloudroom/threads/${parent.id}/running`,
        {
          headers: { [CALLER_TOKEN_HEADER]: harness.callerToken },
          signal,
        },
      ),
    );
  try {
    await service.sandboxes.connection(
      parent.id,
      { id: parent.projectId, folder: "", repository: null },
      false,
      undefined,
      true,
    );
    awake = [];
    expect(await (await read()).json()).toEqual({ running: [] });
    expect(directoryReads).toBe(2);
    expect(sessions).toHaveLength(0);
    awake = [parent, child];
    const controller = new AbortController();
    const answer = read(controller.signal);
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    controller.abort();
    expect(sessions.every((signal) => signal.aborted)).toBe(true);
    expect(await (await answer).json()).toEqual({ running: null });
    expect(directoryReads).toBe(3);
    const deadline = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      ms === 5_000 ? deadline.signal : timeout(ms),
    );
    const slow = read();
    await vi.waitFor(() => expect(sessions).toHaveLength(4));
    deadline.abort();
    expect(await (await slow).json()).toEqual({ running: null });
    expect(sessions.every((signal) => signal.aborted)).toBe(true);

    vi.mocked(AbortSignal.timeout).mockRestore();
    incomplete = true;
    expect(await (await read()).json()).toEqual({ running: null });
  } finally {
    service.stop();
    await harness.cleanup();
  }
});

it("rejects a confirmed archive of a family containing another account's thread before changing any row", async () => {
  const { harness, service, parent, child, post } = await archiveFixture(true);
  try {
    harness.db
      .update(cloudroomThreads)
      .set({ accountId: "another-account" })
      .where(eq(cloudroomThreads.threadId, child.id))
      .run();
    const result = await post(parent.id, "archive-all?includeLive=true");
    expect(result.status).toBe(409);
    expect((await result.json()).code).toBe("cloudroom_other_account");
    for (const thread of [parent, child])
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeNull();
  } finally {
    service.stop();
    await harness.cleanup();
  }
});

it("restores shared child loops and keeps the Core restore queued until its sandbox is awake", async () => {
  const { harness, service, parent, child, post } = await archiveFixture(true);
  let awake = true;
  let coreArchived = false;
  let archiveSequence = 1;
  const calls: string[] = [],
    restorations: string[] = [];
  const finishArchive = createDeferredPromise<void>();
  vi.spyOn(service.sandboxes, "archive").mockImplementation(async () => {
    await finishArchive.promise;
    awake = false;
  });
  vi.spyOn(service.sandboxes, "followsThreads").mockResolvedValue(true);
  // The website's awake list says what connection() answers: idle unwatched threads only reconnect to awake sandboxes.
  vi.spyOn(service.sandboxes, "isAwake").mockImplementation(() => awake);
  vi.spyOn(service.sandboxes, "restore").mockImplementation(
    async (_, session) => {
      restorations.push(session!);
    },
  );
  vi.spyOn(service.sandboxes, "automations").mockResolvedValue({});
  vi.spyOn(service.sandboxes, "connection").mockImplementation(
    async (_id, _project, wake) => {
      expect(wake).toBe(false);
      return awake ? { url: "http://127.0.0.1:12341", token: "fixture" } : null;
    },
  );
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/archive") && init.method === "POST") {
      const id = path.split("/")[3];
      const { archived } = JSON.parse(String(init.body));
      coreArchived = archived;
      calls.push((archived ? "archive " : "restore ") + id);
      return Response.json({ id, archived });
    }
    if (path.endsWith("/stop") || path.endsWith("/sleep")) calls.push(path);
    if (path === "/v1/capabilities")
      return Response.json({
        version: 1,
        repository: "/code",
        stop: true,
        resume: true,
        launch_settings: true,
        cloud_threads: true,
        harnesses: [],
      });
    if (path.endsWith("/requests/archive"))
      return Response.json({ archived: coreArchived });
    if (path === `/v1/sessions/cr_${child.id}/stream`) {
      const record = {
        sequence: archiveSequence,
        session_id: "cr_" + child.id,
        kind: "archive",
        data: { user: true, archived: true },
      };
      const after = Number(new URL(url).searchParams.get("after"));
      const frame = `id: ${archiveSequence}\nevent: record\ndata: ${JSON.stringify(record)}\n\n`;
      return new Response(after < archiveSequence ? frame : "", {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    if (path.includes("/stream")) return new Response(null, { status: 503 });
    return Response.json({});
  });
  try {
    const result = await post(parent.id, "archive-all?includeLive=true");
    expect((await result.json()).archivedThreadIds).toEqual([
      child.id,
      parent.id,
    ]);
    await vi.waitFor(() =>
      expect(service.sandboxes.archive).toHaveBeenCalled(),
    );
    await post(child.id, "unarchive?keepParent=true");
    await post(parent.id, "unarchive?keepParent=true");
    finishArchive.resolve();
    await vi.waitFor(() =>
      expect(restorations.sort()).toEqual(
        ["cr_" + child.id, "cr_" + parent.id].sort(),
      ),
    );
    const pending = () =>
      harness.db
        .select()
        .from(cloudroomCommands)
        .all()
        .find((c) => c.command === "unarchive_session");
    expect(pending()?.state).toBe("sending");
    expect(calls).toEqual(["archive cr_" + child.id]);
    awake = true;
    service.start();
    await vi.waitFor(() => expect(pending()?.state).toBe("completed"), {
      timeout: 4000,
    });
    await vi.waitFor(() =>
      expect(
        harness.db
          .select()
          .from(cloudroomThreads)
          .where(eq(cloudroomThreads.threadId, child.id))
          .get()?.cursor,
      ).toBe(1),
    );
    expect(getThread(harness.db, child.id)?.archivedAt).toBeNull();

    // An archive from another app still applies locally, without writing it back to Core.
    coreArchived = true;
    archiveSequence++;
    await vi.waitFor(
      () =>
        expect(getThread(harness.db, child.id)?.archivedAt).toEqual(
          expect.any(Number),
        ),
      { timeout: 4000 },
    );
    expect(calls).toEqual(["archive cr_" + child.id, "restore cr_" + child.id]);
  } finally {
    finishArchive.resolve();
    service.stop();
    await harness.cleanup();
  }
});
