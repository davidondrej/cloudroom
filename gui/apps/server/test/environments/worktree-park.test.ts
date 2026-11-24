import { execFileSync, spawn } from "node:child_process";
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
import {
  environments,
  getEnvironment,
  getThread,
  listQuietOpenEnvironments,
  threads,
} from "@cloudroom/db";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import {
  parkQuietWorktree,
  requestEnvironmentRemoval,
  restoreParkedWorktree,
  sweepProviderEnvironment,
  sweepProviderLifecycles,
  worktreeRebuiltNote,
  worktreeRebuiltNoteSent,
} from "../../src/services/environments/environment-engine.js";
import { saveWorktreeWork } from "../../src/services/environments/worktree-work.js";
import { setPluginEnvironmentProviderBridge } from "../../src/services/plugins/plugin-environment-provider-registry.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { registerTestHostRpcCapture } from "../helpers/commands.js";
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
  const provider = {
    loseNextRemoveAck: false,
    removed: [] as (string | null)[],
  };
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
      provider.removed.push(context.path);
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
    provider: Awaited<ReturnType<typeof installWorktreeProvider>>;
    host: { id: string };
    session: { id: string };
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

      const { host, session } = seedHostSession(h.deps);
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
        host,
        session,
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
    const parked = await h.app.request(
      `/api/v1/environments/${environment.id}`,
    );
    expect((await parked.json()).lifecycle.phase).toBe("parked");
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

it("keeps a worktree whose thread comes back while an explicit removal runs", () =>
  withWorktree(
    async ({
      h,
      tree,
      provider,
      host,
      session,
      environment,
      thread,
      archive,
    }) => {
      h.db
        .update(environments)
        .set({ providerOwnsPath: true })
        .where(eq(environments.id, environment.id))
        .run();
      registerTestHostRpcCapture(h.deps, {
        hostId: host.id,
        sessionId: session.id,
        onEnvironmentHook: async () => {
          h.db
            .update(threads)
            .set({ archivedAt: null })
            .where(eq(threads.id, thread.id))
            .run();
        },
      });
      archive();
      const deleted = await h.app.request(
        `/api/v1/environments/${environment.id}`,
        { method: "DELETE" },
      );
      expect(deleted.status).toBe(200);
      await sweepProviderLifecycles(h.deps);
      expect(provider.removed).toEqual([]);
      expect(existsSync(join(tree, "draft.txt"))).toBe(true);
      expect(getEnvironment(h.db, environment.id)).toMatchObject({
        status: "ready",
        teardownStatus: null,
      });
    },
  ));

it.each([
  ["the same folder", null],
  [
    "a Windows folder in another letter case and slash direction",
    ["C:\\Work\\thr_task-1", "c:/work/THR_TASK-1"],
  ],
])(
  "keeps a worktree when another environment's live thread works in %s",
  (_label, windows) =>
    withWorktree(async ({ h, tree, provider, host, environment, archive }) => {
      const [own, other] = windows ?? [tree, tree];
      h.db
        .update(environments)
        .set({ path: own, providerOwnsPath: true })
        .where(eq(environments.id, environment.id))
        .run();
      const { project } = seedProjectWithSource(h.deps, {
        hostId: host.id,
        path: "/tmp/other-project",
      });
      const shared = seedEnvironment(h.deps, {
        hostId: host.id,
        projectId: project.id,
        path: other,
      });
      seedThread(h.deps, {
        projectId: project.id,
        environmentId: shared.id,
        status: "idle",
      });
      const warn = vi.spyOn(h.deps.logger, "warn");
      archive();
      await sweepProviderLifecycles(h.deps);
      // Project deletion asks again every 10 s; the refusal waits for its recheck.
      expect(requestEnvironmentRemoval(h.deps, environment.id)).toBe(true);
      await sweepProviderEnvironment(h.deps, environment.id);
      expect(provider.removed).toEqual([]);
      expect(
        warn.mock.calls.filter(
          (call) => call[1] === "Environment removal refused",
        ),
      ).toHaveLength(1);
      expect(git(tree, "status", "--porcelain")).toContain("draft.txt");
      expect(getEnvironment(h.db, environment.id)).toMatchObject({
        teardownStatus: null,
        parkedAt: null,
      });
    }),
);

const DAY_MS = 24 * 60 * 60_000;
/** The worktrees `parkQuietWorktrees` would pick: open, and unused for a day. */
const quietWorktrees = (h: TestAppHarness, hostId: string) =>
  listQuietOpenEnvironments(h.db, {
    hostId,
    providerId: "git-worktree",
    since: Date.now() - DAY_MS,
    limit: 5,
  });
/** Makes the thread and its worktree look last used two days ago. */
const lastUsed = (
  h: TestAppHarness,
  thread: { id: string },
  environment: { id: string },
  change: object = {},
) => {
  const updatedAt = Date.now() - 2 * DAY_MS;
  h.db.update(threads).set({ updatedAt, ...change }).where(eq(threads.id, thread.id)).run();
  h.db.update(environments).set({ updatedAt }).where(eq(environments.id, environment.id)).run();
};

it("parks an open thread's unused worktree and rebuilds it for the next message", () =>
  withWorktree(async ({ h, repo, tree, host, environment, thread }) => {
    writeFileSync(join(repo, ".gitignore"), "private/\n.env\n");
    writeFileSync(join(tree, ".gitignore"), "private/\n.env\n");
    writeFileSync(join(tree, ".env"), "SECRET=1");
    lastUsed(h, thread, environment);
    expect(quietWorktrees(h, host.id)).toEqual([environment.id]);

    expect(
      await parkQuietWorktree(h.deps, environment.id, Date.now() - DAY_MS),
    ).toBe(true);
    expect(existsSync(tree)).toBe(false);
    expect(getEnvironment(h.db, environment.id)).toMatchObject({
      status: "ready",
      teardownStatus: null,
      parkedAt: expect.any(Number),
    });
    expect(getThread(h.db, thread.id)?.archivedAt).toBeNull();
    expect(quietWorktrees(h, host.id)).toEqual([]);
    // Its open thread keeps the lifecycle sweep away: it stays parked.
    await sweepProviderLifecycles(h.deps);
    expect(getEnvironment(h.db, environment.id)?.parkedAt).not.toBeNull();
    expect(worktreeRebuiltNote(environment.id)).toBeNull();
    // The git panel says why the folder is gone.
    const status = await h.app.request(`/api/v1/environments/${environment.id}/status`);
    expect((await status.json()).failure.message).toContain("Parked");

    await restoreParkedWorktree(h.deps, thread.id, environment.id);
    expect(git(tree, "status", "--porcelain").split("\n").sort()).toEqual([
      "",
      " M .gitignore",
      "?? draft.txt",
    ]);
    expect(readFileSync(join(tree, "private", "plan.md"), "utf8")).toBe("plan");
    expect(readFileSync(join(tree, ".env"), "utf8")).toBe("SECRET=1");
    expect(worktreeRebuiltNote(environment.id)?.visibility).toBe("agent-only");
    worktreeRebuiltNoteSent(environment.id);
    expect(worktreeRebuiltNote(environment.id)).toBeNull();
    // The rebuild counts as a use: it isn't parked again right away.
    expect(quietWorktrees(h, host.id)).toEqual([]);
  }));

it("never parks a worktree that was used since it was picked", () =>
  withWorktree(async ({ h, tree, provider, host, environment, thread }) => {
    lastUsed(h, thread, environment);
    expect(quietWorktrees(h, host.id)).toEqual([environment.id]);
    // A message, terminal, fork or Teleport passes here first.
    await restoreParkedWorktree(h.deps, thread.id, environment.id);
    expect(quietWorktrees(h, host.id)).toEqual([]);
    expect(
      await parkQuietWorktree(h.deps, environment.id, Date.now() - DAY_MS),
    ).toBe(false);
    expect(provider.removed).toEqual([]);
    expect(existsSync(join(tree, "draft.txt"))).toBe(true);
  }));

it.each([
  ["was used since", { updatedAt: Date.now() }, null],
  ["is pinned", { pinnedAt: Date.now() }, null],
  ["is working", { status: "active" }, null],
  [
    "has a process running in its folder",
    {},
    (tree: string) => {
      const running = spawn("sleep", ["30"], { cwd: tree, stdio: "ignore" });
      return () => void running.kill();
    },
  ],
  [
    "has a teardown script",
    {},
    (_tree: string, hooks: string) => {
      mkdirSync(join(hooks, ".."), { recursive: true });
      writeFileSync(hooks, JSON.stringify({ version: 1, teardown: "ZXhpdA==" }));
      return () => rmSync(join(hooks, "..", ".."), { recursive: true });
    },
  ],
])("leaves the worktree of an open thread that %s", (_label, change, use) =>
  withWorktree(async ({ h, tree, provider, host, environment, thread }) => {
    lastUsed(h, thread, environment, change);
    // Where the test host's daemon would have saved this environment's hooks.
    const stop = use?.(
      tree,
      `/tmp/bb-host-data/${host.id}/environment-hooks/${environment.id}.json`,
    );
    try {
      // The database can't see a process or a script: those two are picked, then left.
      expect(quietWorktrees(h, host.id)).toEqual(use ? [environment.id] : []);
      expect(
        await parkQuietWorktree(h.deps, environment.id, Date.now() - DAY_MS),
      ).toBe(false);
    } finally {
      stop?.();
    }
    expect(provider.removed).toEqual([]);
    expect(git(tree, "status", "--porcelain")).toBe("?? draft.txt\n");
    expect(getEnvironment(h.db, environment.id)).toMatchObject({
      status: "ready",
      teardownStatus: null,
      parkedAt: null,
    });
  }),
);

it("drops a quiet park that a restart cut off before it removed anything, and undoes its save", () =>
  withWorktree(async ({ h, repo, tree, provider, environment }) => {
    const head = git(tree, "rev-parse", "HEAD");
    // The park saved the work, then the app quit before removing anything.
    await saveWorktreeWork(tree, join(h.config.dataDir, "worktree-notes", environment.id), "x");
    expect(git(tree, "status", "--porcelain")).toBe("");
    h.db.update(environments).set({ teardownStatus: "running" }).where(eq(environments.id, environment.id)).run();
    await sweepProviderLifecycles(h.deps);
    expect(provider.removed).toEqual([]);
    expect(git(tree, "rev-parse", "HEAD")).toBe(head);
    expect(git(tree, "status", "--porcelain")).toBe("?? draft.txt\n");
    expect(git(repo, "log", "-1", "--format=%s", "room/task")).toBe("base\n");
    expect(getEnvironment(h.db, environment.id)).toMatchObject({
      status: "ready",
      teardownStatus: null,
      parkedAt: null,
    });
  }));

it("a message that meets a failed park has it finished, then gets its folder back", () =>
  withWorktree(async ({ h, tree, provider, environment, thread }) => {
    lastUsed(h, thread, environment);
    provider.loseNextRemoveAck = true;
    expect(
      await parkQuietWorktree(h.deps, environment.id, Date.now() - DAY_MS),
    ).toBe(false);
    expect(existsSync(tree)).toBe(false);
    expect(getEnvironment(h.db, environment.id)?.teardownStatus).toBe("failed");

    // The message makes the retry due now, and the next sweep (every 10 s) runs it.
    const restoring = restoreParkedWorktree(h.deps, thread.id, environment.id);
    await sweepProviderLifecycles(h.deps);
    await restoring;
    expect(getEnvironment(h.db, environment.id)).toMatchObject({
      teardownStatus: null,
      parkedAt: null,
    });
    expect(git(tree, "status", "--porcelain")).toBe("?? draft.txt\n");
  }));
