import { expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { cloudroomThreads, threads } from "@cloudroom/db";
import { saveTeleportProgress } from "../../src/services/cloudroom/store.js";
import { seedEnvironment, seedHost, seedPrimaryHost, seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

vi.mock("../../src/services/cloudroom/teleport-local.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/services/cloudroom/teleport-local.js")>(),
  teleportingToLocal: () => true,
}));

it("lets tab and read-state writes through while Teleport to Local runs", async () => {
  await withTestHarness(async (harness) => {
    const { thread } = seedThreadFixture(harness);
    const request = (path: string, method: string, body?: unknown) => harness.app.request(`/api/v1/threads/${thread.id}${path}`, {
      method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });

    expect((await request("/tabs", "PUT", { expectedRevision: 0, tabs: [{ id: "git-diff", kind: "git-diff" }] })).status).toBe(200);
    expect((await request("/read", "POST", {})).status).not.toBe(409);
    expect((await request("", "PATCH", { title: "Renamed" })).status).toBe(200);
    const send = await request("/stop", "POST", {});
    expect(send.status).toBe(409);
    expect(await send.json()).toMatchObject({ code: "teleport_in_progress", message: "Teleport to Local is in progress." });
  });
});

it("Teleport to Local names the real blocker: a move in progress, already here, or Local on another computer (#1974)", async () => {
  await withTestHarness(async (harness) => {
    const { host, project, thread } = seedThreadFixture(harness);
    const toLocal = async () => {
      const response = await harness.app.request(`/api/v1/cloudroom/threads/${thread.id}/teleport`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "local" }),
      });
      return { status: response.status, ...await response.json() as { code: string; message: string } };
    };
    const refused = (message: string) => ({ status: 409, code: "teleport_unavailable", message });
    const progress = (phase: "stopping" | "running" | "complete") => saveTeleportProgress(harness.db, thread.id, { id: "t", owner: thread.id, phase, completed: 0, total: 1 });

    // A move to Cloud was accepted and is stopping the Local agent: no claim about where the thread ends up.
    progress("stopping");
    expect(await toLocal()).toMatchObject(refused("A Teleport for this thread is still in progress (stopping). Try again once it finishes."));
    // Its only connected host may be remote: without this computer's own host id, make no claim about it.
    progress("complete");
    expect(await toLocal()).toMatchObject(refused("This thread is not in Cloud."));
    // A repeated request after the move landed.
    seedPrimaryHost(harness.deps, host.id);
    expect(await toLocal()).toMatchObject(refused(expect.stringMatching(/^This thread is already on this /)));
    // Local, but on another enrolled computer.
    const other = seedEnvironment(harness, { hostId: seedHost(harness, { name: "Other" }).id, projectId: project.id });
    harness.db.update(threads).set({ environmentId: other.id }).where(eq(threads.id, thread.id)).run();
    expect(await toLocal()).toMatchObject(refused("This thread is not in Cloud."));
    // In Cloud, with its move there still running.
    harness.db.update(threads).set({ executionTarget: "cloud", environmentId: null }).where(eq(threads.id, thread.id)).run();
    harness.db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: "http://core", startRequestId: "start", sessionId: "cr_1974", nativeId: "native", model: "m", reasoning: "medium" }).run();
    progress("running");
    expect(await toLocal()).toMatchObject(refused("A Teleport for this thread is still in progress (running). Try again once it finishes."));
  });
});
