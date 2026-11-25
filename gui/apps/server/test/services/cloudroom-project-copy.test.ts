import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import type { CloudroomClient } from "../../src/services/cloudroom/client.js";
import { cloudroomCommands, cloudroomThreads, createThread, getProject, replaceProjectGitRemoteUrl, setProjectGithubRepo } from "@cloudroom/db";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { copyProject, envRefusal, githubRepository, localFiles, localProjectNote, movedRepos, pack, planProjectCopyOrThrow, projectRemote, refreshProjectRemote } from "../../src/services/cloudroom/project-copy.js";
import { parseGhHostsLogin } from "../../src/services/cloudroom/sandboxes.js";
import { redactSecrets } from "../../src/services/cloudroom/shares.js";
import { projectCopyProgress, saveProjectCopyProgress } from "../../src/services/cloudroom/store.js";
import { seedHostSession, seedPrimaryHost, seedProjectWithSource } from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

it("Teleport to Cloud copies staged, unstaged, and untracked work plus ignored .env files", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloudroom-project-copy-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args]);
  const write = (text: string) => (path: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  try {
    git("init", "-q");
    writeFileSync(join(root, ".gitignore"), "node_modules\n.env\n");
    ["staged.txt", "unstaged.txt", "clean.txt", ".env.example", "env.template"].forEach(write("old"));
    git("add", ".");
    git("commit", "-qm", "init");
    ["staged.txt", "added.txt", "unstaged.txt", "untracked.txt", ".env", ".env.example", ".env.test", "apps/web/.env", ".env.ita", "node_modules/pkg/index.js"].forEach(write("new"));
    git("add", "staged.txt", "added.txt", ".env.test");
    git("mv", "env.template", ".env.local");
    git("add", "-N", ".env.ita");

    expect((await localFiles(root, "changed")).sort()).toEqual([".env", ".env.example", ".env.ita", ".env.local", ".env.test", "added.txt", "apps/web/.env", "staged.txt", "unstaged.txt", "untracked.txt"]);
    // Decision (#140): a project at a repo root keeps its ignored `.env` files at any depth, since monorepo apps need theirs.
    // A committed `.env.example` comes from the clone, so its edit stays here (#1405); staged new, renamed and intent-to-add ones are sent.
    expect((await localFiles(root, "env")).sort()).toEqual([".env", ".env.ita", ".env.local", ".env.test", "apps/web/.env"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("Windows packs non-ASCII and long file names so the sandbox's tar unpacks them unchanged (#2224)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloudroom-project-copy-"));
  const files = ["docs/Financiën.md", `src/${"lang-".repeat(30)}.ts`, "😀 notes.txt"];
  try {
    for (const path of files) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), path);
    }
    await pack(root, files, join(root, "out.tgz"), "win32");
    mkdirSync(join(root, "cloud"));
    execFileSync("tar", ["-xzf", join(root, "out.tgz"), "-C", join(root, "cloud")]);
    expect(files.map((path) => readFileSync(join(root, "cloud", path), "utf8"))).toEqual(files);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("copies a non-repo-root project's .env files only from its root and the roots of nested repos (#140)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloudroom-project-copy-"));
  try {
    for (const path of [".env", "app.js", "secrets/.env.prod", "tools/config/.env.local", "api/.git/HEAD", "api/.env.production", "api/src/.env", "web/.git", "web/.env"]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), "x");
    }
    expect((await localFiles(root, "env")).sort()).toEqual([".env", "api/.env.production", "web/.env"]);
    expect((await localFiles(root, "all")).sort()).toEqual([".env", "api/.env.production", "app.js", "web/.env"]);
    // But a home folder, or a GitHub project's folder that is no checkout of it, sends none (#1120).
    expect([envRefusal(homedir(), null), envRefusal(root, "https://github.com/a/b"), envRefusal(root, null), envRefusal(join(root, "api"), "https://github.com/a/b")].map(Boolean)).toEqual([true, true, false, false]);

    // A project folder inside another Git checkout is listed by Git, but gets the same rule.
    const inner = join(root, "checkout/workspace");
    for (const path of [".env", "secrets/.env.production", "config/.env.local"]) {
      mkdirSync(dirname(join(inner, path)), { recursive: true });
      writeFileSync(join(inner, path), "x");
    }
    execFileSync("git", ["init", "-q", join(root, "checkout")]);
    writeFileSync(join(root, "checkout/.gitignore"), ".env*\n");
    expect((await localFiles(inner, "env")).sort()).toEqual([".env"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("sends a Cloud loop run's child no .env files when the run didn't pick them (ADR 0342)", async () => {
  const harness = await createTestAppHarness();
  const root = mkdtempSync(join(tmpdir(), "cloudroom-project-copy-"));
  try {
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    writeFileSync(join(root, ".env.local"), "SECRET=2\n");
    writeFileSync(join(root, "app.js"), "ok\n");
    // The fake Core keeps every uploaded piece; the last command unpacks them.
    const pieces: Buffer[] = [], beats: string[] = [];
    const client = {
      workspace: async () => ({ path: "/code/project" }),
      alive: async (id: string) => { beats.push(id); },
      runOnVm: async (_input: unknown, _signal?: AbortSignal, bytes?: Uint8Array) => { if (bytes?.length) pieces.push(Buffer.from(bytes)); return { code: 0, stdout: "", stderr: "" }; },
    } as unknown as CloudroomClient;
    const copied = (noEnv: boolean) => new Promise<string[]>((resolve, reject) => {
      pieces.length = 0;
      copyProject(harness.deps, client, { threadId: "thr_child", workspace: "w", key: `copy-${noEnv}`, localPath: root, repository: null, clone: false, copyAll: true, teleport: false, ...(noEnv ? { noEnv } : {}) }, (error) => {
        if (error) return reject(new Error(error));
        const archive = join(root, "..", `${noEnv}.tgz`);
        writeFileSync(archive, Buffer.concat(pieces));
        resolve(execFileSync("tar", ["-tzf", archive]).toString().split("\n").filter(Boolean).map(path => path.replace(/^\.\//, "")).sort());
        rmSync(archive, { force: true });
      });
    });
    expect(await copied(true)).toEqual(["app.js"]);
    expect(await copied(false)).toEqual([".env", ".env.local", "app.js"]);
    // Without this heartbeat, `room-cli files wait` can't tell that this computer went offline (#2168).
    expect(beats).toContain("w");
  } finally {
    rmSync(root, { recursive: true, force: true });
    await harness.cleanup();
  }
});

it("removes GitHub tokens from a failed clone's Git output before it is shown (#1847)", () => {
  // Fake tokens only. Git echoes a credential helper's malformed line verbatim; the Mac's own token is removed wherever it is.
  const stderr = [
    "warning: invalid credential line: gho_EXAMPLE_NOT_A_REAL_TOKEN",
    "warning: url has a password: https://x:FAKE-mac-login-1234@github.com/o/r",
    "fatal: could not read Password for 'https://FAKEtokenOnly42@github.com': terminal prompts disabled",
    "remote: ghs_12345_eyJFAKEheader0.eyJFAKEpayload0.FAKE-sig_value0 and Authorization: Basic eC1hY2Nlc3MtdG9rZW46RkFLRQ==",
    "fatal: Authentication failed for 'https://github.com/o/r.git/'",
    "see https://user:pa'ssFAKE@example.org/x or https://example.org?email=a@b.org",
  ].join("\n");
  const safe = redactSecrets(stderr, ["FAKE-mac-login-1234", ""]);
  expect(safe).not.toMatch(/gho_|FAKE|eyJ|eC1h/);
  expect(safe).toContain("invalid credential line: [secret removed]");
  expect(safe).toContain("could not read Password for 'https://[secret removed]@github.com'");
  expect(safe).toContain("Authentication failed for 'https://github.com/o/r.git/'");
  // A whole login, apostrophes included, but never an `@` past the host, like a query's email.
  expect(safe).toContain("see https://[secret removed]@example.org/x or https://example.org?email=a@b.org");
});

it("a project folder on this computer decides its repo: its own checkout's origin is saved, not the repo it was added inside (#1850) or an old one (#2548)", async () => {
  const harness = await createTestAppHarness();
  const root = mkdtempSync(join(tmpdir(), "cloudroom-project-copy-"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args]);
  try {
    const app = join(root, "app");
    mkdirSync(app);
    git(root, "init", "-q");
    git(root, "remote", "add", "origin", "https://github.com/example/outer.git");
    const { deps } = harness;
    const { host: mine } = seedHostSession(deps, { id: "host_mine" });
    const { host: other } = seedHostSession(deps, { id: "host_other" });
    seedPrimaryHost(deps, mine.id);
    // Both added while `app` was a plain subfolder, so the outer repo's remote was saved (here in another form).
    const [here, elsewhere] = [mine, other].map(({ id }) => {
      const { project } = seedProjectWithSource(deps, { hostId: id, path: app, name: id });
      setProjectGithubRepo(deps.db, deps.hub, project.id, { githubRepoId: 1, gitRemoteUrl: "git@github.com:Example/Outer" });
      return { project, thread: createThread(deps.db, deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: "idle" }) };
    });
    const client = { workspace: async () => null } as unknown as CloudroomClient;
    const repository = async (thread: { id: string }) => (await planProjectCopyOrThrow(deps, client, thread.id, "w"))?.repository ?? null;
    const saved = (project: { id: string }) => { const row = getProject(deps.db, project.id); return [row?.gitRemoteUrl, row?.githubRepoId]; };

    expect(await repository(here!.thread)).toBe("https://github.com/Example/Outer");
    // Its own repo without an origin changes nothing yet.
    git(app, "init", "-q");
    await refreshProjectRemote(deps, here!.project.id);
    expect(saved(here!.project)).toEqual(["git@github.com:Example/Outer", 1]);
    expect(await repository(here!.thread)).toBe("https://github.com/Example/Outer");
    // Warming the sandbox saves the fix first, so its template, loops and sync read it too.
    git(app, "remote", "add", "origin", "git@github.com:example/app.git");
    await refreshProjectRemote(deps, here!.project.id);
    expect(saved(here!.project)).toEqual(["git@github.com:example/app.git", null]);
    expect(await repository(here!.thread)).toBe("https://github.com/example/app.git");
    // A rename check that looked up the old repo before the fix can't put it back.
    setProjectGithubRepo(deps.db, deps.hub, here!.project.id, { githubRepoId: 1, gitRemoteUrl: "git@github.com:Example/Outer" }, "git@github.com:Example/Outer");
    expect(saved(here!.project)).toEqual(["git@github.com:example/app.git", null]);
    // A remote saved while the folder was being checked wins.
    replaceProjectGitRemoteUrl(deps.db, deps.hub, here!.project.id, "git@github.com:example/app.git", "https://github.com/example/newer.git");
    expect(await projectRemote(deps, { id: here!.project.id, gitRemoteUrl: "git@github.com:Example/Outer" }, app)).toBe("https://github.com/example/newer.git");
    expect(saved(here!.project)).toEqual(["https://github.com/example/newer.git", null]);
    // Any later change to the folder's origin, like a split repo, is saved too, and stays a move for the website until
    // a warm-up sends it, whatever saved it: here a new thread's copy (#2548).
    movedRepos.clear();
    git(app, "remote", "set-url", "origin", "git@github.com:example/split.git");
    expect(await repository(here!.thread)).toBe("https://github.com/example/split.git");
    expect(saved(here!.project)).toEqual(["git@github.com:example/split.git", null]);
    await refreshProjectRemote(deps, here!.project.id);
    expect([...movedRepos]).toEqual([here!.project.id]);
    // Another computer's folder path that also exists here is left alone.
    expect(await repository(elsewhere!.thread)).toBe("https://github.com/Example/Outer");
    expect(saved(elsewhere!.project)).toEqual(["git@github.com:Example/Outer", 1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await harness.cleanup();
  }
});

it("a project whose GitHub origin has a token saves it clean and copies as a GitHub project, like its template (#2190)", async () => {
  const harness = await createTestAppHarness();
  const app = mkdtempSync(join(tmpdir(), "cloudroom-project-copy-"));
  try {
    execFileSync("git", ["-C", app, "init", "-q"]);
    execFileSync("git", ["-C", app, "remote", "add", "origin", "https://alice:FAKE_TOKEN@github.com/example/app.git"]);
    writeFileSync(join(app, ".env"), "A=1\n");
    const { deps } = harness;
    const { host } = seedHostSession(deps, { id: "host_token" });
    seedPrimaryHost(deps, host.id);
    const { project } = seedProjectWithSource(deps, { hostId: host.id, path: app });
    const thread = createThread(deps.db, deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: "idle" });
    // A new Cloud thread reads the note first, which saves the remote.
    expect(await localProjectNote(deps, project.id)).toBeUndefined();
    const saved = getProject(deps.db, project.id)?.gitRemoteUrl ?? null;
    expect(saved).toBe("https://github.com/example/app.git");
    // The template (sandboxProject) clones githubRepository(saved); the copy must agree, empty folder or pre-cloned.
    const plan = (filled: boolean) => planProjectCopyOrThrow(deps, { workspace: async () => ({ path: "/w" }), runOnVm: async () => ({ code: filled ? 1 : 0 }) } as unknown as CloudroomClient, thread.id, "w");
    expect(await plan(false)).toMatchObject({ repository: githubRepository(saved), clone: true, copyAll: false });
    expect(await plan(true)).toMatchObject({ repository: githubRepository(saved), clone: false, copyAll: false });
    // A project with neither a local folder on this machine nor a GitHub remote skips /v1/workspaces altogether.
    const { project: emptyProject } = seedProjectWithSource(deps, { hostId: host.id, path: join(app, "missing") });
    const emptyThread = createThread(deps.db, deps.hub, { executionTarget: "cloud", projectId: emptyProject.id, providerId: "codex", status: "idle" });
    let workspaceChecked = false;
    expect(await planProjectCopyOrThrow(deps, { workspace: async () => { workspaceChecked = true; return null; } } as unknown as CloudroomClient, emptyThread.id, "w")).toBeNull();
    expect(workspaceChecked).toBe(false);
  } finally {
    rmSync(app, { recursive: true, force: true });
    await harness.cleanup();
  }
});

it("parseGhHostsLogin only reads github.com entries and never crosses into other hosts", () => {
  expect(parseGhHostsLogin("github.com:\n    user: alice\n")).toEqual({ found: true, user: "alice" });
  expect(parseGhHostsLogin("github.com:\n    oauth_token: gho_fake\n")).toEqual({ found: true, user: null });
  expect(parseGhHostsLogin("github.com:\n    git_protocol: https\nenterprise.example.com:\n    oauth_token: gho_other\n")).toEqual({ found: false, user: null });
  expect(parseGhHostsLogin("")).toEqual({ found: false, user: null });
});

it("explicitRetry surfaces non-login clone errors instead of quietly completing, and retryCopy refreshes the owning sandbox", async () => {
  const harness = await createTestAppHarness();
  const root = mkdtempSync(join(tmpdir(), "cloudroom-retry-copy-"));
  const service = cloudroom(harness.deps);
  try {
    const { deps } = harness;
    const { host } = seedHostSession(deps, { id: "host_retry" });
    seedPrimaryHost(deps, host.id);
    const { project } = seedProjectWithSource(deps, { hostId: host.id, path: root });
    setProjectGithubRepo(deps.db, deps.hub, project.id, { githubRepoId: 2, gitRemoteUrl: "https://github.com/acme/private.git" });
    const thread = createThread(deps.db, deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: "idle" });

    // 1. explicitRetry reports phase="error" even when a local project folder exists and clone fails for a non-login reason.
    const failingClient = {
      workspace: async () => ({ path: "/code/private" }),
      alive: async () => {},
      runOnVm: async ({ command }: { command: string }) => {
        if (command.includes("git clone")) {
          return { code: 1, stdout: Buffer.from("\x1dalice").toString("hex"), stderr: Buffer.from("remote: Repository not found.").toString("hex") };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    } as unknown as CloudroomClient;
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void) => { fn(); return 0 as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout;
    try {
      await new Promise<void>((resolve) => {
        copyProject(deps, failingClient, {
          threadId: thread.id, workspace: "bb_proj", key: "retry-explicit", localPath: root,
          repository: "https://github.com/acme/private", clone: true, copyAll: false, teleport: false, explicitRetry: true,
        }, () => resolve());
      });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    const afterFail = projectCopyProgress(deps.db, thread.id);
    expect(afterFail?.phase).toBe("error");
    expect(afterFail?.error).toContain("can't see this repository");

    // 2. retryCopy on a shared-sandbox child refreshes the owning parent sandbox and clears stale error when folder already has files.
    deps.db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: "sandbox:thr_parent_box", sessionId: "cr_child", startRequestId: "req_1", model: "test", reasoning: "medium" }).run();
    deps.db.insert(cloudroomCommands).values({ id: `first_${thread.id}`, threadId: thread.id, command: "prompt", state: "completed", input: JSON.stringify({ workspace: "bb_proj" }), createdAt: Date.now() }).run();
    saveProjectCopyProgress(deps.db, thread.id, { phase: "error", completed: 0, total: 0, error: "Cloud sandboxes have no working GitHub login." });
    const refreshed: string[] = [];
    service.sandboxes.refreshGithub = async (target: string) => { refreshed.push(target); };
    (service as unknown as { rt: { client: () => Promise<CloudroomClient> } }).rt.client = async () => ({
      workspace: async () => ({ path: "/code/private" }),
      runOnVm: async () => ({ code: 1, stdout: "", stderr: "" }), // folder already has files
    } as unknown as CloudroomClient);
    const result = await service.retryCopy(thread.id);
    expect(result).toEqual({ status: "folder_not_empty" });
    expect(refreshed).toEqual(["thr_parent_box"]);
    expect(projectCopyProgress(deps.db, thread.id)?.phase).toBe("complete");
  } finally {
    service.stop();
    rmSync(root, { recursive: true, force: true });
    await harness.cleanup();
  }
});
