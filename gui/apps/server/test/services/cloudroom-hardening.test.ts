import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { chatFileCopyPath, saveChatFileCopy } from "@cloudroom/config/chat-file-copies";
import { createThread } from "@cloudroom/db";
import { CHAT_FILE_COPIES_DIR_NAME, ensureDataPrivateDir } from "@cloudroom/process-utils";
import { CloudroomConnectionError, CloudroomError, type CloudroomClient } from "../../src/services/cloudroom/client.js";
import { CloudSync, type SyncHost } from "../../src/services/cloudroom/cloud-sync.js";
import { CloudThreadStates } from "../../src/services/cloudroom/cloud-threads.js";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { isProjectNudgeEnabled, writeSummaries } from "../../src/services/cloudroom/project-nudge.js";
import { SandboxDirectory } from "../../src/services/cloudroom/sandboxes.js";
import { cloudFile } from "../../src/services/cloudroom/teleport-local.js";
import { writeUiPreference } from "../../src/services/system/ui-preferences.js";
import { deleteThreadOnMac } from "../../src/services/threads/thread-lifecycle.js";
import { seedHostSession, seedPrimaryHost, seedProjectWithSource } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("Cloud thread deletion hardening", () => {
  it("keeps pending deletes per account, ignores 400, clears on confirmation/404, and does not block sync", async () => {
    await withTestHarness(async (harness) => {
      let currentAccount = "user_a";
      const removed: Array<{ account: string; threadId: string }> = [];
      let releaseSlow: (() => void) | null = null;
      let slowOnce = true;
      let fail400Once = true;
      let followsCount = 0;

      const sandboxes = {
        account: async () => ({ userId: currentAccount }),
        followsThreads: async () => {
          followsCount += 1;
          return false;
        },
        remove: async (threadId: string) => {
          removed.push({ account: currentAccount, threadId });
          if (threadId === "thr_bad_400" && fail400Once) {
            fail400Once = false;
            throw new CloudroomError("Invalid request", 400);
          }
          if (threadId === "thr_already_gone") {
            throw new CloudroomError("Not found", 404);
          }
          if (threadId === "thr_slow" && slowOnce) {
            slowOnce = false;
            await new Promise<void>((resolve) => { releaseSlow = resolve; });
          }
        },
      } as unknown as SandboxDirectory;

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

      const sync = new CloudSync(harness.deps, hostShim);
      const stateFile = join(harness.deps.config.dataDir, "cloudroom-thread-sync.json");

      // Child thread deleted without owning a sandbox is never queued.
      await sync.deletedHere("thr_child_only", false);
      expect(JSON.parse(await readFile(stateFile, "utf8")).pendingDeletesByAccount).toEqual({});

      // HTTP 400 must NOT clear the pending delete.
      await sync.deletedHere("thr_bad_400", true);
      await sync.removeOnWebsite("thr_bad_400");
      expect(JSON.parse(await readFile(stateFile, "utf8")).pendingDeletesByAccount).toEqual({
        user_a: ["thr_bad_400"],
      });

      // Switch to account B and sync: A's pending deletes must survive untouched.
      currentAccount = "user_b";
      await sync.deletedHere("thr_b_other", false);
      await sync.run();
      expect(JSON.parse(await readFile(stateFile, "utf8")).pendingDeletesByAccount).toEqual({
        user_a: ["thr_bad_400"],
      });

      // Switch back to A, add a slow delete + a 404 delete: sync.run() must return without waiting for thr_slow.
      currentAccount = "user_a";
      await sync.deletedHere("thr_slow", true);
      await sync.deletedHere("thr_already_gone", true);
      const beforeFollows = followsCount;
      await sync.run();
      expect(followsCount).toBe(beforeFollows + 1);
      await vi.waitFor(() => { expect(releaseSlow).not.toBeNull(); });

      // Release the slow delete and confirm all of A's pending deletes drain cleanly.
      releaseSlow!();
      await vi.waitFor(async () => {
        expect(JSON.parse(await readFile(stateFile, "utf8")).pendingDeletesByAccount).toEqual({});
      });
      expect(removed).toEqual([
        { account: "user_a", threadId: "thr_bad_400" },
        { account: "user_a", threadId: "thr_bad_400" },
        { account: "user_a", threadId: "thr_slow" },
        { account: "user_a", threadId: "thr_already_gone" },
      ]);
      sync.stop();
    });
  });

  it("rejects non-JSON/HTML 200 replies on sandbox remove and accepts matching deleted JSON", async () => {
    let mode: "html" | "deleted" = "html";
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body) as { thread?: string };
      if (mode === "html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body>Captive portal</body></html>");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ thread: parsed.thread, state: "deleted" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server failed to listen");

    try {
      const directory = new SandboxDirectory(async () => ({
        token: "tok",
        userId: "user_1",
        website: `http://127.0.0.1:${address.port}`,
      }));
      await expect(directory.remove("thr_remove_check")).rejects.toBeInstanceOf(CloudroomConnectionError);
      mode = "deleted";
      await expect(directory.remove("thr_remove_check")).resolves.toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });

  it("removes cached local chat-file-copies on Cloud thread delete and does not recreate them from an in-flight download", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-cloud-delete",
      });
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/cloud-delete-images",
      });

      const thread = createThread(harness.db, harness.deps.hub, {
        id: "thr_cloudimg01",
        projectId: project.id,
        executionTarget: "cloud",
        providerId: "claude-code",
        environmentId: null,
        title: "Cloud with cached image",
      });

      await ensureDataPrivateDir(harness.deps.config.dataDir, CHAT_FILE_COPIES_DIR_NAME);
      await saveChatFileCopy({
        data: Buffer.from("png-bytes"),
        dataDir: harness.deps.config.dataDir,
        filePath: "/tmp/shot.png",
        threadId: thread.id,
      });
      const copyPath = chatFileCopyPath(harness.deps.config.dataDir, thread.id, "/tmp/shot.png");
      expect(existsSync(copyPath!)).toBe(true);

      // Start an in-flight download for a second image, delete the thread before it completes, then let it finish.
      const latePath = join(harness.deps.config.dataDir, "sandbox-late.png");
      await writeFile(latePath, "late-png");
      let releaseDownload: (() => void) | null = null;
      let pausedOnce = false;
      const sandbox = {
        runOnVm: async (input: { command: string }) => {
          if (!pausedOnce) {
            pausedOnce = true;
            await new Promise<void>((resolve) => { releaseDownload = resolve; });
          }
          const result = spawnSync("bash", ["-c", input.command]);
          return {
            code: result.status ?? 1,
            stdout: result.stdout.toString("hex"),
            stderr: result.stderr.toString("hex"),
            truncated: false,
          };
        },
      } as unknown as CloudroomClient;
      vi.spyOn(cloudroom(harness.deps), "threadClient").mockResolvedValue(sandbox);

      const downloadPromise = cloudFile(harness.deps, thread.id, latePath);
      await vi.waitFor(() => { expect(releaseDownload).not.toBeNull(); });

      deleteThreadOnMac(harness.deps, thread);
      releaseDownload!();
      await expect(downloadPromise).resolves.toEqual(Buffer.from("late-png"));

      await vi.waitFor(() => {
        expect(existsSync(join(harness.deps.config.dataDir, CHAT_FILE_COPIES_DIR_NAME, thread.id))).toBe(false);
      });
    });
  });
});

describe("project-nudge plan gating", () => {
  it("stays disabled when plan is null or free, honors mid-load opt-out, and enables on paid plans", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-nudge-gate" });
      const repoDir = join(harness.deps.config.dataDir, "repo-nudge");
      await mkdir(repoDir, { recursive: true });
      await writeFile(join(repoDir, "README.md"), "# Test repo\n");
      seedProjectWithSource(harness.deps, { hostId: host.id, path: repoDir });

      const sandboxes = cloudroom(harness.deps).sandboxes;
      const planSpy = vi.spyOn(sandboxes, "currentPlan").mockReturnValue(null);
      const accountSpy = vi.spyOn(sandboxes, "account").mockResolvedValue(null);
      const modeSpy = vi.spyOn(sandboxes, "forNewThreads").mockResolvedValue(true);

      // Signed out: currentPlan() is null -> must stay disabled and never hit the website.
      expect(isProjectNudgeEnabled(harness.deps)).toBe(false);
      await writeSummaries(harness.deps);
      expect(modeSpy).not.toHaveBeenCalled();

      // Signed in on Free (plan not loaded yet): checks forNewThreads once, sees "free", stays disabled.
      accountSpy.mockResolvedValue({ userId: "u1", token: "tok", website: "https://cloudroom.dev" });
      modeSpy.mockImplementation(async () => {
        planSpy.mockReturnValue("free");
        return true;
      });
      await writeSummaries(harness.deps);
      expect(modeSpy).toHaveBeenCalledTimes(1);
      expect(isProjectNudgeEnabled(harness.deps)).toBe(false);

      // User turns off preference while forNewThreads() is in flight: must stop before touching projects.
      planSpy.mockReturnValue(null);
      modeSpy.mockImplementation(async () => {
        planSpy.mockReturnValue("pro");
        writeUiPreference(harness.deps, { expectedRevision: 0, key: "projectNudge.enabled", value: false });
        return true;
      });
      await writeSummaries(harness.deps);
      expect(isProjectNudgeEnabled(harness.deps)).toBe(false);

      // Reset preference and confirm paid plan enables it.
      writeUiPreference(harness.deps, { expectedRevision: 1, key: "projectNudge.enabled", value: null });
      planSpy.mockReturnValue("pro");
      expect(isProjectNudgeEnabled(harness.deps)).toBe(true);
    });
  });
});
