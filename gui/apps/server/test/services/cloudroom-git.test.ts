import { execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloudGitEnvironmentId } from "@cloudroom/domain";
import { cloudroomThreads, createThread } from "@cloudroom/db";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { lastGitStatus } from "../../src/services/cloudroom/store.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { CloudGitError, cloudGitBranches, cloudGitDiffFiles, cloudGitDiffPatch, cloudGitFile, cloudGitStatus, type CloudGitRun } from "../../src/services/cloudroom/git.js";

let repo: string;
let origin: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const write = (path: string, text: string) => writeFileSync(join(repo, path), text);
// Runs the script the way Core's /v1/vm/run does: bash, in the checkout, stdin piped.
const runIn = (cwd: () => string): CloudGitRun => async (script, stdin) => {
  const result = spawnSync("/bin/bash", ["-c", script], { cwd: cwd(), input: stdin ?? Buffer.alloc(0), maxBuffer: 64 << 20 });
  if (result.status !== 0) throw new CloudGitError(result.stderr.toString().trim() || `exit ${result.status} ${result.signal ?? ""}`, result.status);
  return result.stdout;
};
const run = runIn(() => repo);

beforeEach(() => {
  origin = mkdtempSync(join(tmpdir(), "cloud-git-origin-"));
  repo = mkdtempSync(join(tmpdir(), "cloud-git-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "agent@example.com");
  git("config", "user.name", "Agent");
  write("keep.txt", "one\ntwo\n");
  write("old-name.txt", "rename me\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Base");
  git("remote", "add", "origin", origin);
  git("push", "-q", "-u", "origin", "main");
  git("remote", "set-head", "origin", "main");
  git("checkout", "-q", "-b", "room/feature");
  write("feature.txt", "new feature\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Add feature");
  write("keep.txt", "one\ntwo\nthree\n");
  write("untracked.txt", "a\nb\n");
  renameSync(join(repo, "old-name.txt"), join(repo, "new-name.txt"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(origin, { recursive: true, force: true });
});

describe("cloud git", () => {
  it("reads branch, commits ahead of the default branch, and uncommitted files with line counts, without growing .git", async () => {
    const objects = git("count-objects", "-v");
    const status = await cloudGitStatus(run);
    expect(git("count-objects", "-v")).toBe(objects);
    expect(status.checkout).toMatchObject({ kind: "branch", branchName: "room/feature" });
    expect(status.branch).toEqual({ currentBranch: "room/feature", defaultBranch: "main" });
    expect(status.mergeBase).toMatchObject({ mergeBaseBranch: "main", aheadCount: 1, behindCount: 0, hasCommittedUnmergedChanges: true, insertions: 1 });
    expect(status.mergeBase?.commits.map((commit) => commit.subject)).toEqual(["Add feature"]);
    expect(status.mergeBase?.files).toEqual([{ path: "feature.txt", status: "A", insertions: 1, deletions: 0 }]);
    expect(status.workingTree.state).toBe("dirty_and_committed_unmerged");
    expect(status.workingTree.files).toEqual(expect.arrayContaining([
      { path: "keep.txt", status: "M", insertions: 1, deletions: 0 },
      { path: "untracked.txt", status: "??", insertions: 2, deletions: 0 },
      { path: "old-name.txt", status: "D", insertions: 0, deletions: 1 },
    ]));
    expect(git("status", "--porcelain")).toContain("?? untracked.txt");

    write("keep.txt", "one\ntwo\nstaged\n");
    git("add", "keep.txt");
    write("keep.txt", "one\ntwo\n");
    expect((await cloudGitStatus(run)).workingTree.files).toContainEqual(expect.objectContaining({ path: "keep.txt", status: "M" }));
  });

  it("diffs uncommitted work, untracked files and renames included, without touching the real index", async () => {
    const files = await cloudGitDiffFiles(run, { type: "uncommitted" });
    expect(files.files.map(({ path, previousPath, changeKind, origin: from }) => ({ path, previousPath, changeKind, from }))).toEqual(expect.arrayContaining([
      { path: "keep.txt", previousPath: null, changeKind: "modified", from: "tracked" },
      { path: "new-name.txt", previousPath: "old-name.txt", changeKind: "renamed", from: "untracked" },
      { path: "untracked.txt", previousPath: null, changeKind: "added", from: "untracked" },
    ]));
    expect(files.mergeBaseRef).toBeNull();
    expect(files.initialPatches.find((patch) => patch.path === "keep.txt")?.patch).toContain("+three");

    const [renamed] = await cloudGitDiffPatch(run, { type: "uncommitted" }, ["new-name.txt"], files.files);
    expect(renamed?.patch).toContain("rename from old-name.txt");
    expect(git("diff", "--cached", "--name-only")).toBe("");
  });

  it("diffs branch commits against the merge base and reads both sides of a file", async () => {
    const files = await cloudGitDiffFiles(run, { type: "branch_committed", mergeBaseBranch: "main" });
    expect(files.files.map((file) => file.path)).toEqual(["feature.txt"]);
    expect(files.mergeBaseRef).toBe(git("rev-parse", "main"));

    const sha = git("rev-parse", "HEAD");
    const [patch] = await cloudGitDiffPatch(run, { type: "commit", sha }, ["feature.txt"]);
    expect(patch?.patch).toContain("+new feature");

    expect(await cloudGitFile(run, { target: "uncommitted", path: "keep.txt", side: "new" })).toMatchObject({ content: "one\ntwo\nthree\n", contentEncoding: "utf8", mimeType: "text/plain" });
    expect(await cloudGitFile(run, { target: "all", mergeBaseRef: git("rev-parse", "main"), path: "keep.txt", side: "old" })).toMatchObject({ content: "one\ntwo\n" });
  });

  it("never writes to .git, even for big untracked files or a split index, and keeps odd file names intact", async () => {
    git("config", "core.splitIndex", "true");
    git("update-index", "--split-index");
    const before = readdirSync(join(repo, ".git")).sort();
    const objects = git("count-objects", "-v");
    write("big.bin", "x".repeat(2 * 1024 * 1024));
    const odd = "we\x1eird name\n";
    write(odd, "odd\n");

    const status = await cloudGitStatus(run);
    expect(status.workingTree.files).toContainEqual({ path: "big.bin", status: "??", insertions: null, deletions: null });
    expect(status.workingTree.lineStatsComplete).toBe(false);
    const files = await cloudGitDiffFiles(run, { type: "uncommitted" });
    expect(files.files).toContainEqual(expect.objectContaining({ path: "big.bin", binary: true, origin: "untracked" }));
    expect(files.files).toContainEqual(expect.objectContaining({ path: odd, changeKind: "added" }));
    expect(await cloudGitFile(run, { target: "uncommitted", path: odd, side: "new" })).toMatchObject({ content: "odd\n" });

    expect(git("count-objects", "-v")).toBe(objects);
    expect(readdirSync(join(repo, ".git")).sort()).toEqual(before);
  });

  it("treats a squash-merged branch as merged, like Local", async () => {
    git("stash", "-u", "-q");
    write("second.txt", "second\n");
    git("add", "-A");
    git("commit", "-q", "-m", "Add second");
    git("checkout", "-q", "main");
    write("feature.txt", "new feature\n");
    write("second.txt", "second\n");
    git("add", "-A");
    git("commit", "-q", "-m", "Squash: add feature");
    git("push", "-q", "origin", "main");
    git("checkout", "-q", "room/feature");
    expect((await cloudGitStatus(run)).mergeBase).toMatchObject({ aheadCount: 0, behindCount: 1, commits: [], files: [] });
  });

  it("caps each patch in the sandbox, refuses a missing comparison branch, and lists remote branches", async () => {
    write("huge.txt", "x".repeat(600 * 1024));
    const [huge, keep] = await cloudGitDiffPatch(run, { type: "uncommitted" }, ["huge.txt", "keep.txt"]);
    expect(huge).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(huge?.patch ?? "")).toBeLessThanOrEqual(512 * 1024);
    expect(keep).toMatchObject({ truncated: false, patch: expect.stringContaining("+three") });

    const many = Array.from({ length: 30 }, (_, index) => `many-${index}.txt`);
    for (const path of many) write(path, "y".repeat(600 * 1024));
    const patches = await cloudGitDiffPatch(run, { type: "uncommitted" }, many);
    expect(patches.reduce((total, patch) => total + Buffer.byteLength(patch.patch), 0)).toBeLessThanOrEqual(12 * 1024 * 1024);
    expect(patches.every((patch) => patch.truncated)).toBe(true);

    await expect(cloudGitDiffFiles(run, { type: "branch_committed", mergeBaseBranch: "nope" })).rejects.toMatchObject({ exitCode: 5 });
    expect(await cloudGitBranches(run, undefined, 50, "origin/main")).toMatchObject({ branches: ["main", "room/feature"], remoteBranches: ["origin/main"], selectedBranch: { name: "origin/main", kind: "remote" } });
  });

  it("never runs hooks or textconv", async () => {
    writeFileSync(join(repo, ".git", "hooks", "post-index-change"), `#!/bin/sh\ntouch "${join(repo, "hook-ran")}"\n`, { mode: 0o755 });
    git("config", "diff.sample.textconv", "sed s/^/X/");
    git("config", "diff.sample.cachetextconv", "true");
    write(".gitattributes", "*.txt diff=sample\n");
    const objects = git("count-objects", "-v");

    await cloudGitStatus(run);
    const [patch] = await cloudGitDiffPatch(run, { type: "uncommitted" }, ["keep.txt"]);
    expect(patch?.patch).toContain("\n+three");
    expect(existsSync(join(repo, "hook-ran"))).toBe(false);
    expect(git("for-each-ref", "refs/notes")).toBe("");
    expect(git("count-objects", "-v")).toBe(objects);
  });

  it("uses only objects already in a blobless clone, and fails instead of reporting clean", async () => {
    const bare = mkdtempSync(join(tmpdir(), "cloud-git-promisor-"));
    const clone = mkdtempSync(join(tmpdir(), "cloud-git-blobless-"));
    try {
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
      execFileSync("git", ["-C", bare, "config", "uploadpack.allowFilter", "true"]);
      git("stash", "-u", "-q");
      write("file.txt", "base\n");
      git("add", "file.txt");
      git("commit", "-q", "-m", "File");
      git("push", "-q", bare, "room/feature:main");
      write("file.txt", "base\nfeature\n");
      git("commit", "-q", "-am", "Change file");
      git("push", "-q", bare, "room/feature:feature");
      git("checkout", "-q", "-B", "side", "room/feature~1");
      write("other.txt", "main\n");
      git("add", "other.txt");
      git("commit", "-q", "-m", "Main moves on");
      git("push", "-q", bare, "side:main");
      execFileSync("git", ["clone", "-q", "--filter=blob:none", "--branch", "feature", `file://${bare}`, clone], { stdio: "ignore" });
      const inClone = runIn(() => clone);
      const packs = readdirSync(join(clone, ".git", "objects", "pack")).sort();
      const expected = { aheadCount: 1, behindCount: 1, commits: [expect.objectContaining({ subject: "Change file" })], files: [{ path: "file.txt", status: "M", insertions: null, deletions: null }], lineStatsComplete: false };

      expect((await cloudGitStatus(inClone)).mergeBase).toMatchObject(expected);
      await expect(cloudGitDiffPatch(inClone, { type: "branch_committed", mergeBaseBranch: "main" }, ["file.txt"])).rejects.toBeInstanceOf(CloudGitError);
      expect(readdirSync(join(clone, ".git", "objects", "pack")).sort()).toEqual(packs);

      rmSync(bare, { recursive: true, force: true });
      expect((await cloudGitStatus(inClone)).mergeBase).toMatchObject(expected);
    } finally {
      rmSync(bare, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("reports a folder that is not a Git repository", async () => {
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    await expect(cloudGitStatus(run)).rejects.toMatchObject({ exitCode: 3 });
  });
});

it("serves a Cloud thread's Git status and diff through the environment API, and the last status while Core is away", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  let away = false;
  const core = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (away) return json({}, 503);
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: repo, stop: true, resume: true, launch_settings: true, harnesses: [] });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url === "/v1/sessions/cr_git/workspace") return json({ path: repo, branch: "room/feature", head: null });
    if (req.url === "/v1/vm/run") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const input = JSON.parse(text) as { command: string; stdin: string; cwd: string };
      const result = spawnSync("/bin/bash", ["-lc", input.command], { cwd: input.cwd, input: Buffer.from(input.stdin, "hex"), maxBuffer: 64 << 20 });
      return json({ code: result.status, stdout: result.stdout.toString("hex"), stderr: result.stderr.toString("hex"), truncated: false });
    }
    json({}, 404);
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    await service.configure({ url, token: "x".repeat(40) });
    const thread = createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: "idle" });
    harness.deps.db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: url, startRequestId: "git", sessionId: "cr_git", model: "test-model", reasoning: "medium" }).run();
    const read = async (path: string) => (await harness.app.request(`/api/v1/environments/${cloudGitEnvironmentId(thread.id)}/${path}`)).json() as Promise<Record<string, unknown>>;

    const live = await read("status");
    expect(live).toMatchObject({ outcome: "available", workspace: { branch: { currentBranch: "room/feature" }, mergeBase: { aheadCount: 1 } } });
    git("branch", "release");
    harness.deps.db.update(cloudroomThreads).set({ lastGitStatus: null }).run();
    const [both] = await Promise.all([read("status"), read("status?mergeBaseBranch=release")]);
    expect(both).toEqual(live);
    expect(JSON.parse(lastGitStatus(harness.deps.db, thread.id) ?? "{}")).toEqual({ "": live.workspace, release: expect.anything() });
    expect(await read("diff/files?target=branch_committed&mergeBaseBranch=main")).toMatchObject({ outcome: "available", files: [{ path: "feature.txt", changeKind: "added" }] });
    expect(await read("pull-request")).toEqual({ outcome: "absent" });

    const snapshots = lastGitStatus(harness.deps.db, thread.id);
    const index = readFileSync(join(repo, ".git", "index"));
    writeFileSync(join(repo, ".git", "index"), "broken");
    expect(await read("status")).toEqual(live);
    expect(lastGitStatus(harness.deps.db, thread.id)).toBe(snapshots);
    writeFileSync(join(repo, ".git", "index"), index);

    away = true;
    expect(await read("status")).toEqual(live);
    expect(await read("diff/files?target=branch_committed&mergeBaseBranch=main")).toMatchObject({ outcome: "available", files: [{ path: "feature.txt" }] });
    expect(await read("diff/files?target=uncommitted")).toMatchObject({ outcome: "unavailable" });
  } finally {
    service.stop(); core.closeAllConnections(); await new Promise<void>(resolve => core.close(() => resolve())); await harness.cleanup();
  }
}, 30000);

it("checks which files exist in a Cloud thread's sandbox, past login-shell output", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const core = createServer(async (req, res) => {
    const json = (body: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: repo, stop: true, resume: true, launch_settings: true, harnesses: [] });
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url === "/v1/vm/run") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const input = JSON.parse(text) as { command: string };
      const result = spawnSync("/bin/bash", ["-c", input.command]);
      return json({ code: result.status, stdout: Buffer.concat([Buffer.from("Welcome banner\n1\n"), result.stdout]).toString("hex"), stderr: "", truncated: false });
    }
    res.writeHead(404); res.end();
  });
  core.listen(0, "127.0.0.1"); await once(core, "listening");
  const address = core.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    await service.configure({ url, token: "x".repeat(40) });
    const thread = createThread(harness.deps.db, harness.deps.hub, { executionTarget: "cloud", projectId: project.id, providerId: "codex", status: "idle" });
    harness.deps.db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl: url, startRequestId: "exist", sessionId: "cr_exist", model: "test-model", reasoning: "medium" }).run();
    const response = await harness.app.request(`/api/v1/threads/${thread.id}/host-files/exist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [join(repo, "keep.txt"), join(repo, "missing.md"), "relative.md"] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ existence: { [join(repo, "keep.txt")]: true, [join(repo, "missing.md")]: false } });
  } finally {
    service.stop(); core.closeAllConnections(); await new Promise<void>(resolve => core.close(() => resolve())); await harness.cleanup();
  }
}, 30000);
