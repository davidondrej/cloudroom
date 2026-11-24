import { expect, it } from "vitest";
import { events, projects, threads } from "@cloudroom/db";
import { createTestDb } from "../helpers/test-app.js";
import { recentCloudRuns, tokenUsageSince, weightedRun, type CloudRun } from "../../src/services/cloudroom/loop-usage.js";

// Loop usage estimates (docs/scopes/loops.md): Cloud loop runs this computer never opened still count, once each.
it("counts every Cloud loop run this computer hasn't seen, and none twice", () => {
  const db = createTestDb(), now = 1_000_000_000, week = now - 100;
  db.insert(projects).values({ id: "proj_1", name: "p", createdAt: 1, updatedAt: 1 } as never).run();
  for (const id of ["thr_seen", "thr_same", "thr_other"])
    db.insert(threads).values({ id, projectId: "proj_1", providerId: "claude-code", status: "idle", latestAttentionAt: now, createdAt: now, updatedAt: now } as never).run();
  const reading = (threadId: string, sequence: number, at: number, outputTokens: number) => db.insert(events).values({ id: `${threadId}_${sequence}`, threadId, scopeKind: "thread", sequence,
    type: "thread/tokenUsage/updated", data: JSON.stringify({ tokenUsage: { total: { inputTokens: 0, outputTokens } } }), createdAt: at } as never).run();
  reading("thr_seen", 1, now - 10, 100);
  reading("thr_same", 1, now - 50, 100);
  const run = (thread: string, at: number, harness = "claude-code"): CloudRun => ({ thread, at, harness, input: 1000, output: 100, cacheRead: 10_000, cacheWrite: 400 });
  expect(weightedRun(run("x", 0))).toBe(1000 + 1000 + 500 + 500);
  const cloud = [
    run("thr_seen", now - 20), // this computer has its turn already
    run("thr_same", now - 60), run("thr_same", now - 40), run("thr_same", now - 30), // a same-thread loop: two runs after its last reading here
    run("thr_never", now - 5), run("thr_never", week - 1), // a run thread never opened; one run before the week
    run("thr_codex", now - 5, "codex"),
  ];
  const input = { providerId: "claude-code", threadIds: ["thr_same", "thr_never"], threadsSince: week, totalSince: week };
  const local = tokenUsageSince(db, input).total;
  const { total, threads: perThread } = tokenUsageSince(db, input, cloud);
  expect(total).toBe(local + 3 * 3000);
  expect(perThread).toEqual({ thr_same: 500 + 2 * 3000, thr_never: 3000 });
  expect(tokenUsageSince(db, { ...input, providerId: "codex", threadIds: [] }, cloud).total).toBe(3000);
});

it("reads an account's Cloud runs at most every 10 minutes, never another account's, and retries a failed read", async () => {
  let asked = 0;
  const runs = [{ thread: "thr_1", at: 1, harness: "codex", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }];
  const ask = async () => { asked += 1; return { tokens: [...runs, { thread: 5 }, { thread: "thr_2", at: 1, input: "x" }] }; };
  expect(await recentCloudRuns(null, ask)).toEqual([]);
  expect(asked).toBe(0);
  expect(await recentCloudRuns("site a", ask, 1)).toEqual(runs);
  await recentCloudRuns("site a", ask, 2);
  expect(asked).toBe(1);
  await recentCloudRuns("site b", ask, 3);
  expect(asked).toBe(2);
  expect(await recentCloudRuns("site c", async () => { throw new Error("down"); }, 4)).toEqual([]);
  expect(await recentCloudRuns("site c", ask, 5)).toEqual(runs);
});
