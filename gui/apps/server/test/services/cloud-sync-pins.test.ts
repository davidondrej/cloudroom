import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getThread, unpinThread } from "@cloudroom/db";
import { describe, expect, it } from "vitest";
import {
  CloudSync,
  type SyncHost,
} from "../../src/services/cloudroom/cloud-sync.js";
import { CloudThreadStates } from "../../src/services/cloudroom/cloud-threads.js";
import type {
  SandboxDirectory,
  ThreadChange,
  ThreadPage,
} from "../../src/services/cloudroom/sandboxes.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const makeRow = (
  overrides: Partial<ThreadChange> &
    Pick<ThreadChange, "thread" | "session" | "project">,
): ThreadChange => ({
  project_name: "app",
  repository: null,
  title: "Pinned Cloud run",
  state: "open",
  sandbox: "asleep",
  harness: "codex",
  model: "gpt-6.2-astra",
  reasoning: "high",
  parent: null,
  parent_state: null,
  loop: true,
  pinned_at: null,
  created_at: "2026-11-21T18:00:00.000Z",
  woke_at: "2026-11-21T18:00:00.000Z",
  updated_at: "2026-11-21T18:00:00.000Z",
  ...overrides,
});

describe("CloudSync agent pins", () => {
  it("backfills pre-upgrade pins once, preserves manual unpins, re-pins on newer timestamps, and retries after write failure", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-cloud-sync-pins",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/cloud-sync-pins",
      });

      // Simulate an existing Mac upgraded from an older version whose cursor already passed the pinned thread.
      const savedCursor = "2026-11-21T19:00:00.000Z~";
      await writeFile(
        join(harness.deps.config.dataDir, "cloudroom-thread-sync.json"),
        JSON.stringify({
          account: "user_1",
          cursor: savedCursor,
          first: false,
        }),
      );

      const pinnedAt1 = "2026-11-21T18:05:00.000Z";
      const pinnedAt2 = "2026-11-21T20:05:00.000Z";
      let regularRows: ThreadChange[] = [];
      let pinnedOnlyRows: ThreadChange[] = [
        makeRow({
          thread: "thr_upgraded",
          session: "cr_upgraded",
          project: project.id,
          pinned_at: pinnedAt1,
        }),
      ];
      let pinnedOnlyCalls = 0;

      const sandboxes = {
        account: async () => ({ userId: "user_1" }),
        followsThreads: async () => true,
        threads: async (
          _since: string | null,
          options?: { pinnedOnly?: boolean },
        ): Promise<ThreadPage> => {
          if (options?.pinnedOnly) {
            pinnedOnlyCalls += 1;
            return {
              threads: pinnedOnlyRows,
              next: "2026-11-21T19:00:00.000Z~",
              more: false,
              recheck_ms: 3_600_000,
              recheck_offline_ms: 600_000,
            };
          }
          return {
            threads: regularRows,
            next: savedCursor,
            more: false,
            recheck_ms: 3_600_000,
            recheck_offline_ms: 600_000,
          };
        },
      } as unknown as SandboxDirectory;

      const hostShim: SyncHost = {
        sandboxes,
        threadStates: new CloudThreadStates(
          join(harness.deps.config.dataDir, "cloudroom-thread-state.json"),
        ),
        me: async () => "tag_1234567890ab",
        quietly: (_id, apply) => apply(),
        isHome: () => true,
        restoredSince: () => false,
        detach: () => {},
        adopted: () => {},
        resendLabel: () => {},
      };

      const sync = new CloudSync(harness.deps, hostShim);

      // 1. Upgrade backfill adopts and pins the sleeping thread once without resetting cursor.
      await sync.run();
      expect(pinnedOnlyCalls).toBe(1);
      expect(getThread(harness.db, "thr_upgraded")?.pinnedAt).toBe(
        Date.parse(pinnedAt1),
      );

      // 2. Manual unpin stays unpinned on subsequent syncs with the same pinned_at, and backfill does not re-run.
      unpinThread(harness.db, harness.deps.hub, { threadId: "thr_upgraded" });
      expect(getThread(harness.db, "thr_upgraded")?.pinnedAt).toBeNull();
      regularRows = [
        makeRow({
          thread: "thr_upgraded",
          session: "cr_upgraded",
          project: project.id,
          pinned_at: pinnedAt1,
          updated_at: "2026-11-21T19:30:00.000Z",
        }),
      ];
      await sync.run();
      expect(pinnedOnlyCalls).toBe(1);
      expect(getThread(harness.db, "thr_upgraded")?.pinnedAt).toBeNull();

      // 3. A failed SQLite write on a newer agent pin must not mark pinnedAt2 seen; the next sync still pins it.
      regularRows = [
        makeRow({
          thread: "thr_upgraded",
          session: "cr_upgraded",
          project: project.id,
          pinned_at: pinnedAt2,
          updated_at: "2026-11-21T20:05:00.000Z",
        }),
      ];
      const realTx = harness.db.transaction.bind(harness.db);
      let failOnce = true;
      harness.db.transaction = ((
        ...args: Parameters<typeof harness.db.transaction>
      ) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("SQLITE_BUSY");
        }
        return realTx(...args);
      }) as typeof harness.db.transaction;

      await sync.run();
      expect(getThread(harness.db, "thr_upgraded")?.pinnedAt).toBeNull();

      // Retry succeeds and pins the thread with the newer timestamp.
      await sync.run();
      expect(getThread(harness.db, "thr_upgraded")?.pinnedAt).toBe(
        Date.parse(pinnedAt2),
      );
    });
  });
});
