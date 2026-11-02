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
import { environments, getEnvironment, getThread, threads } from "@cloudroom/db";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import {
  restoreParkedWorktree,
  sweepProviderLifecycles,
} from "../../src/services/environments/environment-engine.js";
import { setPluginEnvironmentProviderBridge } from "../../src/services/plugins/plugin-environment-provider-registry.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { textInput } from "../helpers/prompt-input.js";
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
  const provider = { loseNextRemoveAck: false };
  h.pluginService.getApi("fake-worktree")!.experimental_environments.register({
    id: "git-worktree",
    displayName: "Worktree",
    description: "Worktree fixture",
    icon: "FolderGit",
    create: async (context) => {
      const path = join(repo, "..", context.pathKey);
      const branch =
        context.previous?.environment.branchName ?? context.suggestedBranchName;
      const exists =
        git(repo, "branch", "--list", branch).trim() !== "";
      git(repo, "worktree", "add", "-q", ...(exists ? [path, branch] : ["-b", branch, path]));
      return { status: "created", path, ownsPath: true };
    },
    remove: async (context) => {
      if (existsSync(context.path!))
        git(repo, "worktree", "remove", "--force", context.path!);
      if (provider.loseNextRemoveAck) {
        provider.loseNextRemoveAck = false;
        throw new Error("Lost the removal acknowledgement");
      }
      return { status: "removed" };
    },
  });
  return provider;
}

async function withWorktree(
  run: (args: {
    h: TestAppHarness;
    repo: string;
    tree: string;
    provider: { loseNextRemoveAck: boolean };
    project: { id: string };
    environment: { id: string };
    thread: { id: string };
    archive: () => void;
  }) => Promise<void>,
  options: { detached?: boolean } = {},
) {
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
      git(repo, "worktree", "add", "-q", ...(options.detached ? ["--detach", tree] : ["-b", "room/task", tree]));
      writeFileSync(join(tree, "draft.txt"), "draft");
      mkdirSync(join(tree, "private"));
      writeFileSync(join(tree, "private", "plan.md"), "plan");
      const provider = await installWorktreeProvider(h, repo);

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
        branchName: options.detached ? null : "room/task",
      });
      const thread = seedThread(h.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      await run({
        h,
        repo,
        tree,
        provider,
        project,
        environment,
        thread,
        archive: () =>
          h.db.update(threads).set({ archivedAt: Date.now() }).where(eq(threads.id, thread.id)).run(),
      });
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

it("parks an archived thread's worktree and brings it back with its unfinished work", () =>
  withWorktree(async ({ h, repo, tree, environment, thread, archive }) => {
    archive();
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
    await restoreParkedWorktree(h.deps, thread.id, environment.id);
    expect(git(tree, "status", "--porcelain")).toBe("?? draft.txt\n");
    expect(readFileSync(join(tree, "private", "plan.md"), "utf8")).toBe("plan");
    expect(getEnvironment(h.db, environment.id)?.parkedAt).toBeNull();
  }));

it("restores a detached worktree's work after a removal retry", () =>
  withWorktree(
    async ({ h, tree, provider, environment, thread, archive }) => {
      provider.loseNextRemoveAck = true;
      archive();
      await sweepProviderLifecycles(h.deps);
      expect(existsSync(tree)).toBe(false);
      expect(getEnvironment(h.db, environment.id)?.teardownStatus).toBe("failed");

      h.db.update(environments).set({ retireAt: Date.now() }).where(eq(environments.id, environment.id)).run();
      await sweepProviderLifecycles(h.deps);
      expect(getEnvironment(h.db, environment.id)?.parkedAt).toEqual(expect.any(Number));

      await restoreParkedWorktree(h.deps, thread.id, environment.id);
      expect(git(tree, "status", "--porcelain")).toBe("?? draft.txt\n");
    },
    { detached: true },
  ));

it("finishes deleting a parked worktree, and its thread can come back", () =>
  withWorktree(async ({ h, environment, thread, archive }) => {
    archive();
    await sweepProviderLifecycles(h.deps);
    expect(getEnvironment(h.db, environment.id)?.parkedAt).toEqual(expect.any(Number));

    const deleted = await h.app.request(`/api/v1/environments/${environment.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    await sweepProviderLifecycles(h.deps);
    expect(getEnvironment(h.db, environment.id)).toMatchObject({
      status: "destroyed",
      teardownStatus: "removed",
      parkedAt: null,
    });

    const unarchived = await h.app.request(`/api/v1/threads/${thread.id}/unarchive`, {
      method: "POST",
    });
    expect(unarchived.status).toBe(200);
  }));

it("rebuilds a parked worktree for a new thread that reuses it", () =>
  withWorktree(async ({ h, tree, project, environment, archive }) => {
    archive();
    await sweepProviderLifecycles(h.deps);
    expect(existsSync(tree)).toBe(false);

    const created = await createThreadFromRequest(h.deps, {
      environment: { type: "reuse", environmentId: environment.id },
      input: textInput("Continue here"),
      model: "gpt-5",
      origin: "app",
      projectId: project.id,
      providerId: "codex",
      startedOnBehalfOf: null,
    });
    await vi.waitFor(() => {
      expect(getThread(h.db, created.id)?.environmentId).toBe(environment.id);
      expect(getEnvironment(h.db, environment.id)?.parkedAt).toBeNull();
    });
    expect(git(tree, "status", "--porcelain")).toBe("?? draft.txt\n");
  }));
