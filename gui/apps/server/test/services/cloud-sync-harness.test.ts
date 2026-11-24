import { join } from "node:path";
import { getThread } from "@cloudroom/db";
import { describe, expect, it } from "vitest";
import { CloudSync, type SyncHost } from "../../src/services/cloudroom/cloud-sync.js";
import { CloudThreadStates } from "../../src/services/cloudroom/cloud-threads.js";
import type { SandboxDirectory, ThreadChange, ThreadPage } from "../../src/services/cloudroom/sandboxes.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const row = (thread: string, harness: string, project: string): ThreadChange => ({
  thread, session: `cr_${thread}`, project, project_name: "app", repository: null, title: thread, state: "open",
  sandbox: "awake", harness, model: "some-model", reasoning: "medium", parent: null, parent_state: null, loop: false,
  pinned_at: null, created_at: "2026-11-24T10:00:00.000Z", woke_at: null, updated_at: "2026-11-24T10:00:00.000Z",
});

describe("CloudSync harness names", () => {
  // A child the website starts in its own sandbox carries Core's harness name (`antigravity`), not the app's ID.
  it("adopts threads named by Core's harness name as well as by the app's provider ID", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-cloud-sync-harness" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id, path: "/tmp/cloud-sync-harness" });
      const rows = [
        row("thr_codex", "codex", project.id),
        row("thr_agy", "antigravity", project.id),
        row("thr_cursor", "cursor", project.id),
        row("thr_opencode", "acp-opencode", project.id),
      ];
      const page: ThreadPage = { threads: rows, next: "2026-11-24T10:00:00.000Z~", more: false, recheck_ms: 3_600_000, recheck_offline_ms: 600_000 };
      const sandboxes = { account: async () => ({ userId: "user_1" }), followsThreads: async () => true, threads: async () => page } as unknown as SandboxDirectory;
      const hostShim: SyncHost = {
        sandboxes,
        threadStates: new CloudThreadStates(join(harness.deps.config.dataDir, "cloudroom-thread-state.json")),
        me: async () => "tag_1234567890ab",
        quietly: (_id, apply) => apply(),
        isHome: () => true,
        restoredSince: () => false,
        detach: () => {},
        adopted: () => {},
        resendLabel: () => {},
      };
      await new CloudSync(harness.deps, hostShim).run();
      expect(getThread(harness.db, "thr_codex")?.providerId).toBe("codex");
      expect(getThread(harness.db, "thr_agy")?.providerId).toBe("acp-antigravity");
      expect(getThread(harness.db, "thr_cursor")?.providerId).toBe("acp-cursor");
      expect(getThread(harness.db, "thr_opencode")?.providerId).toBe("acp-opencode");
    });
  });
});
