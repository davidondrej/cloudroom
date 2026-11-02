import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEnvironment, threads } from "@cloudroom/db";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  restoreParkedWorktree,
  sweepProviderLifecycles,
} from "../../src/services/environments/environment-engine.js";
import { setPluginEnvironmentProviderBridge } from "../../src/services/plugins/plugin-environment-provider-registry.js";
import {
  seedEnvironment,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString();

async function installWorktreeProvider(h: TestAppHarness, repo: string) {
  const root = join(h.config.dataDir, "bb-plugin-fake-worktree");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "bb-plugin-fake-worktree",
      version: "0.1.0",
      type: "module",
      bb: {
        name: "fake-worktree",
        description: "Worktree fixture",
        branding: { icon: "Zap" },
        server: "./server.js",
      },
    }),
  );
  await writeFile(join(root, "server.js"), "export default function () {}");
  expect((await h.pluginService.installPath(root)).status).toBe("running");
  h.pluginService.getApi("fake-worktree")!.experimental_environments.register({
    id: "git-worktree",
    displayName: "Worktree",
    description: "Worktree fixture",
    icon: "FolderGit",
    create: async (context) => {
      const path = join(repo, "..", context.pathKey);
      git(repo, "worktree", "add", "-q", path, context.previous!.environment.branchName!);
      return { status: "created", path, ownsPath: true };
    },
    remove: async (context) => {
      git(repo, "worktree", "remove", "--force", context.path!);
      return { status: "removed" };
    },
  });
}

it("parks an archived thread's worktree and brings it back with its unfinished work", async () => {
  const base = mkdtempSync(join(tmpdir(), "worktree-park-"));
  try {
    await withTestHarness(async (h) => {
      setPluginEnvironmentProviderBridge(h.pluginService.environmentProviders);
      const repo = join(base, "repo");
      const tree = join(base, "thr_task-1");
      execFileSync("git", ["init", "-q", repo]);
      writeFileSync(join(repo, ".gitignore"), "private/\n");
      git(repo, "add", ".");
      git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
      git(repo, "worktree", "add", "-q", "-b", "room/task", tree);
      writeFileSync(join(tree, "draft.txt"), "draft");
      mkdirSync(join(tree, "private"));
      writeFileSync(join(tree, "private", "plan.md"), "plan");
      await installWorktreeProvider(h, repo);

      const { host } = seedHostSession(h.deps);
      seedPrimaryHost(h.deps, host.id);
      const { project } = seedProjectWithSource(h.deps, { hostId: host.id, path: repo });
      const environment = seedEnvironment(h.deps, {
        hostId: host.id,
        projectId: project.id,
        path: tree,
        environmentProviderId: "git-worktree",
        environmentProviderPluginId: "fake-worktree",
        environmentProviderInstanceKey: "thr_task-1",
        branchName: "room/task",
      });
      const thread = seedThread(h.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      h.db.update(threads).set({ archivedAt: Date.now() }).where(eq(threads.id, thread.id)).run();

      await sweepProviderLifecycles(h.deps);
      expect(existsSync(tree)).toBe(false);
      expect(git(repo, "show", "room/task:draft.txt")).toBe("draft");
      expect(getEnvironment(h.db, environment.id)).toMatchObject({
        status: "ready",
        path: tree,
        parkedAt: expect.any(Number),
      });
      await sweepProviderLifecycles(h.deps);
      expect(getEnvironment(h.db, environment.id)?.parkedAt).not.toBeNull();

      const unarchived = await h.app.request(`/api/v1/threads/${thread.id}/unarchive`, {
        method: "POST",
      });
      expect(unarchived.status).toBe(200);
      await restoreParkedWorktree(h.deps, thread.id);
      expect(git(tree, "status", "--porcelain")).toBe("?? draft.txt\n");
      expect(readFileSync(join(tree, "private", "plan.md"), "utf8")).toBe("plan");
      expect(getEnvironment(h.db, environment.id)?.parkedAt).toBeNull();
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
