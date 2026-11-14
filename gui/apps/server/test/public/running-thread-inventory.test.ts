import { describe, expect, it } from "vitest";
import { archiveThread, cloudroomThreads, getThread, listPublicProjects, setProjectHidden } from "@cloudroom/db";
import { CloudSync, type SyncHost } from "../../src/services/cloudroom/cloud-sync.js";
import { projectRecord, projectShown } from "../../src/services/cloudroom/events.js";
import { binding } from "../../src/services/cloudroom/store.js";
import { seedHostSession, seedProjectWithSource, seedThread } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

async function inventory(app: { request(path: string): Promise<Response> }) {
  const response = await app.request("/api/v1/sidebar-bootstrap");
  expect(response.status).toBe(200);
  return response.json();
}

describe("shared running-thread inventory", () => {
  it("includes live roots and children across hidden projects and visibility without a page cap", async () => {
    await withTestHarness(async h => {
      const { host } = seedHostSession(h.deps);
      const { project } = seedProjectWithSource(h.deps, { hostId: host.id });
      const parent = seedThread(h.deps, { projectId: project.id });
      const workers = Array.from({ length: 60 }, (_, i) => seedThread(h.deps, { projectId: project.id, parentThreadId: i === 0 ? null : parent.id, status: i === 0 ? "stopping" : "active", visibility: "hidden" }));
      seedThread(h.deps, { projectId: project.id, visibility: "hidden" });
      const archived = seedThread(h.deps, { projectId: project.id, status: "active" });
      archiveThread(h.db, h.hub, archived.id);
      setProjectHidden(h.db, h.hub, project.id, true);
      const data = await inventory(h.app);
      expect(data.projects.some((p: { id: string }) => p.id === project.id)).toBe(false);
      expect(data.runningThreads?.map((t: { id: string }) => t.id).sort()).toEqual(workers.map(t => t.id).sort());
      expect(data.runningThreads?.find((t: { id: string }) => t.id === workers[1]!.id)).toMatchObject({ parentThreadId: parent.id, status: "active", execution: { model: null, effort: null, observedAt: null } });
    });
  });

  it("reports observed Core settings and their time, and ignores historical projection", async () => {
    await withTestHarness(async h => {
      const { host } = seedHostSession(h.deps);
      const { project } = seedProjectWithSource(h.deps, { hostId: host.id });
      const thread = seedThread(h.deps, { projectId: project.id });
      h.db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: "sandbox:" + thread.id, sessionId: "cr_inventory", startRequestId: "synthetic-start", model: "configured-model", reasoning: "low" }).run();
      const send = (sequence: number, kind: string, data: Record<string, string>) => projectRecord(h.db, thread.id, { sequence, session_id: "cr_inventory", kind, data, timestamp_ms: 1000 + sequence });
      send(1, "state", { state: "running" });
      expect((await inventory(h.app)).runningThreads?.[0]).toMatchObject({ execution: { status: "active", source: "core", observedAt: 1001, freshness: "last-known", model: null, effort: null } });
      send(2, "native_identity", { id: "native-synthetic", model: "observed-model" });
      send(3, "reasoning", { reasoning: "high" });
      expect((await inventory(h.app)).runningThreads?.[0]).toMatchObject({ execution: { observedAt: 1001, model: "observed-model", effort: "high" } });
      projectShown(h.db, thread.id, [{ sequence: 4, session_id: "cr_inventory", kind: "state", data: { state: "idle" }, timestamp_ms: 1004 }]);
      expect((await inventory(h.app)).runningThreads?.[0]).toMatchObject({ execution: { status: "active", observedAt: 1001 } });
      send(5, "state", { state: "idle" });
      expect((await inventory(h.app)).runningThreads).toEqual([]);
    });
  });

  it("adopts orphan children and remote projects without a checkout or execution ownership", async () => {
    await withTestHarness(async h => {
      const { host } = seedHostSession(h.deps);
      seedProjectWithSource(h.deps, { hostId: host.id });
      let rows = [{ thread: "thr_remote_child", session: "cr_sub_remote", project: "remote-project", project_name: "Remote project", repository: null, title: "Remote worker", state: "open", sandbox: "awake", harness: "codex", model: "configured-model", reasoning: "high", parent: "thr_remote_parent" as string | null, parent_state: "open", loop: false, created_at: "2020-01-01T00:00:00Z", updated_at: "2020-01-01T00:00:00Z", woke_at: null }];
      const states = new Map();
      const sync = new CloudSync(h.deps, {
        sandboxes: { account: async () => ({ userId: "synthetic-account" }), followsThreads: async () => true, threads: async () => ({ threads: rows, next: "cursor", more: false, recheck_ms: 3600000, recheck_offline_ms: 600000 }) },
        threadStates: states, me: async () => "synthetic-install", quietly: (_id: string | null, apply: () => unknown) => apply(), isHome: () => false, detach: () => {}, adopted: () => {}, resendLabel: () => {},
      } as unknown as SyncHost);
      try {
        await sync.run();
        const child = getThread(h.db, "thr_remote_child");
        expect(child).not.toBeNull();
        expect(child?.status).toBe("idle");
        expect(states.get("thr_remote_child")).toMatchObject({ home: "elsewhere", from: null });
        expect(listPublicProjects(h.db).find(p => p.id === child?.projectId)).toMatchObject({ name: "Remote project", gitRemoteUrl: null });
        const data = await inventory(h.app);
        expect(data.projects.flatMap((p: { threads: unknown[] }) => p.threads)).toContainEqual(expect.objectContaining({ id: "thr_remote_child", parentThreadId: "thr_remote_parent" }));
        expect(data.runningThreads).toEqual([]); // awake never means running
        expect(binding(h.db, "thr_remote_child")?.cursor).toBe(0);
        rows = [{ ...rows[0]!, thread: "thr_remote_parent", session: "cr_parent_remote", parent: null }];
        await sync.run();
        expect(getThread(h.db, "thr_remote_child")?.parentThreadId).toBe("thr_remote_parent");
        expect((await inventory(h.app)).projects).toHaveLength(2);
      } finally { sync.stop(); }
    });
  });
});
