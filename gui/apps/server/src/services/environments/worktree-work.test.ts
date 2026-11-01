import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  STALE_WORK_MS,
  worktreeCanBeRemoved,
  worktreeHasNoWork,
} from "./worktree-work.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
const commit = (cwd: string, message: string) =>
  git(
    cwd,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    message,
  );
const withTempDir = async (run: (base: string) => Promise<void>) => {
  const base = mkdtempSync(path.join(tmpdir(), "worktree-work-"));
  try {
    await run(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};

describe("worktreeHasNoWork", () => {
  it("is true only without uncommitted or unpushed work, or with no folder", () =>
    withTempDir(async (base) => {
      const remote = path.join(base, "remote.git");
      const clone = path.join(base, "clone");
      execFileSync("git", ["init", "-q", "--bare", remote]);
      execFileSync("git", ["clone", "-q", remote, clone], { stdio: "pipe" });
      commit(clone, "base");
      git(clone, "push", "-q", "origin", "HEAD");
      expect(await worktreeHasNoWork(clone)).toBe(true);
      git(clone, "config", "status.showUntrackedFiles", "no");
      writeFileSync(path.join(clone, "notes.txt"), "draft");
      expect(await worktreeHasNoWork(clone)).toBe(false);
      git(clone, "add", "notes.txt");
      commit(clone, "local");
      expect(await worktreeHasNoWork(clone)).toBe(false);
      git(clone, "push", "-q", "origin", "HEAD");
      expect(await worktreeHasNoWork(clone)).toBe(true);
      expect(await worktreeHasNoWork(path.join(base, "missing"))).toBe(true);
      git(clone, "remote", "remove", "origin");
      commit(clone, "local-only");
      expect(await worktreeHasNoWork(clone)).toBe(true);
      writeFileSync(path.join(clone, "draft.txt"), "draft");
      expect(await worktreeHasNoWork(clone)).toBe(false);
      rmSync(path.join(clone, "draft.txt"));
      git(clone, "checkout", "-q", "--detach");
      expect(await worktreeHasNoWork(clone)).toBe(true);
      commit(clone, "detached");
      expect(await worktreeHasNoWork(clone)).toBe(false);
    }));

  it("sees submodule edits even when .gitmodules ignores them", () =>
    withTempDir(async (base) => {
      const sub = path.join(base, "sub");
      const parent = path.join(base, "parent");
      execFileSync("git", ["init", "-q", sub]);
      writeFileSync(path.join(sub, "a.txt"), "a");
      git(sub, "add", "a.txt");
      commit(sub, "sub");
      execFileSync("git", ["init", "-q", parent]);
      commit(parent, "base");
      git(
        parent,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "--quiet",
        "add",
        sub,
        "mod",
      );
      git(parent, "config", "-f", ".gitmodules", "submodule.mod.ignore", "all");
      git(parent, "add", ".gitmodules");
      commit(parent, "add submodule");
      expect(await worktreeHasNoWork(parent)).toBe(true);
      writeFileSync(path.join(parent, "mod", "a.txt"), "edited");
      expect(await worktreeHasNoWork(parent)).toBe(false);
    }));

  it("saves work untouched for 30 days to a branch, then allows removal", () =>
    withTempDir(async (base) => {
      const remote = path.join(base, "remote.git");
      const clone = path.join(base, "clone");
      execFileSync("git", ["init", "-q", "--bare", remote]);
      execFileSync("git", ["clone", "-q", remote, clone], { stdio: "pipe" });
      commit(clone, "base");
      git(clone, "push", "-q", "origin", "HEAD");
      git(clone, "checkout", "-q", "--detach");
      writeFileSync(path.join(clone, "draft.txt"), "draft");
      const later = Date.now() + STALE_WORK_MS + 60_000;
      expect(await worktreeCanBeRemoved(clone)).toBe(false);
      expect(await worktreeCanBeRemoved(clone, later)).toBe(true);
      const saved = git(clone, "branch", "--list", "cloudroom/saved-*");
      expect(saved.toString()).toMatch(/cloudroom\/saved-/);
      expect(git(clone, "show", "HEAD:draft.txt").toString()).toBe("draft");
      expect(await worktreeCanBeRemoved(clone, later)).toBe(true);
    }));
});
