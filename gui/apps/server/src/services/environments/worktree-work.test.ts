import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  markRemovalStarted,
  restoreWorktreeWork,
  saveWorktreeWork,
  savedBeforeRemoval,
} from "./worktree-work.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString();
const withRepo = async (run: (base: string, repo: string) => Promise<void>) => {
  const base = mkdtempSync(path.join(tmpdir(), "worktree-work-"));
  const repo = path.join(base, "repo");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(path.join(repo, ".gitignore"), "private/\nnode_modules/\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
    await run(base, repo);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};

describe("saveWorktreeWork and restoreWorktreeWork", () => {
  it("bring unfinished work and private notes back after the folder is rebuilt", () =>
    withRepo(async (base, repo) => {
      const tree = path.join(base, "tree");
      const notes = path.join(base, "notes");
      git(repo, "worktree", "add", "-q", "-b", "room/task", tree);
      writeFileSync(path.join(tree, ".gitignore"), "private/\nnode_modules/\n.env\n");
      writeFileSync(path.join(tree, "draft.txt"), "draft");
      mkdirSync(path.join(tree, "private"));
      writeFileSync(path.join(tree, "private", "plan.md"), "plan");
      mkdirSync(path.join(tree, "node_modules"));

      expect(await saveWorktreeWork(tree, notes, "cloudroom/saved-env")).toBe("room/task");
      git(repo, "worktree", "remove", "--force", tree);
      git(repo, "worktree", "add", "-q", tree, "room/task");
      await restoreWorktreeWork(tree, notes);

      expect(git(tree, "status", "--porcelain").split("\n").sort()).toEqual(
        ["", " M .gitignore", "?? draft.txt"],
      );
      expect(readFileSync(path.join(tree, "private", "plan.md"), "utf8")).toBe("plan");
      expect(existsSync(path.join(tree, "node_modules"))).toBe(false);
      expect(existsSync(notes)).toBe(false);
    }));

  it("lets saved notes win over older notes in the rebuilt folder", () =>
    withRepo(async (base, repo) => {
      const tree = path.join(base, "tree");
      const notes = path.join(base, "notes");
      git(repo, "worktree", "add", "-q", "-b", "room/task", tree);
      mkdirSync(path.join(tree, "private"));
      writeFileSync(path.join(tree, "private", "plan.md"), "newer");

      await saveWorktreeWork(tree, notes, "cloudroom/saved-env");
      git(repo, "worktree", "remove", "--force", tree);
      git(repo, "worktree", "add", "-q", tree, "room/task");
      mkdirSync(path.join(tree, "private"));
      writeFileSync(path.join(tree, "private", "plan.md"), "older");
      await restoreWorktreeWork(tree, notes);

      expect(readFileSync(path.join(tree, "private", "plan.md"), "utf8")).toBe("newer");
      expect(existsSync(notes)).toBe(false);
    }));

  it.each([
    ["a removal cut off half way", "rm"],
    ["a checkout cut off before its index", "index"],
  ])("never commits the mass deletion of %s (#1068)", (_name, damage) =>
    withRepo(async (base, repo) => {
      for (let i = 0; i < 60; i++) writeFileSync(path.join(repo, `f${i}`), "x");
      git(repo, "add", ".");
      git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "files");
      const tree = path.join(base, "tree");
      git(repo, "worktree", "add", "-q", "-b", "room/task", tree);
      writeFileSync(path.join(tree, "draft.txt"), "draft");
      expect(await saveWorktreeWork(tree, path.join(base, "notes"), "cloudroom/saved-env")).toBe("room/task");
      const saved = git(repo, "rev-parse", "room/task");
      for (let i = 0; i < 60; i++) rmSync(path.join(tree, `f${i}`));
      if (damage === "index") rmSync(git(tree, "rev-parse", "--path-format=absolute", "--git-path", "index").trim());
      writeFileSync(path.join(tree, "late.txt"), "late");

      const counts: number[] = [];
      expect(
        await saveWorktreeWork(tree, path.join(base, "notes"), "cloudroom/saved-env", (n) => counts.push(n)),
      ).toBeNull();
      expect(counts).toEqual([damage === "index" ? 62 : 60]);
      expect(git(repo, "rev-parse", "room/task")).toBe(saved);
    }));

  it("keeps a detached HEAD's work on the given branch and stays on it", () =>
    withRepo(async (base, repo) => {
      const tree = path.join(base, "tree");
      git(repo, "worktree", "add", "-q", "--detach", tree);
      writeFileSync(path.join(tree, "draft.txt"), "draft");

      const branch = await saveWorktreeWork(
        tree,
        path.join(base, "notes"),
        "cloudroom/saved-env",
      );

      expect(branch).toBe("cloudroom/saved-env");
      expect(git(repo, "show", `${branch}:draft.txt`)).toBe("draft");
      expect(git(tree, "branch", "--show-current").trim()).toBe(branch);
    }));

  it.each([
    ["files the cut-off removal deleted", "room/task", "old", (tree: string) => rmSync(path.join(tree, "draft.txt"))],
    ["work made after the mark", null, "old", (tree: string) => writeFileSync(path.join(tree, "late.txt"), "late")],
    ["the commit, not notes edited after the mark", "room/task", "new", (tree: string) => writeFileSync(path.join(tree, "private", "plan.md"), "new")],
  ])("on a removal retry, skips saving only %s (#1068)", (_name, expected, note, change) =>
    withRepo(async (base, repo) => {
      const tree = path.join(base, "tree");
      const notes = path.join(base, "notes");
      const marker = path.join(base, "notes.removing");
      git(repo, "worktree", "add", "-q", "-b", "room/task", tree);
      writeFileSync(path.join(tree, "draft.txt"), "draft");
      mkdirSync(path.join(tree, "private"));
      writeFileSync(path.join(tree, "private", "plan.md"), "old");
      await saveWorktreeWork(tree, notes, "cloudroom/saved-env");
      expect(await savedBeforeRemoval(tree, marker, notes)).toBeNull();
      await markRemovalStarted(tree, marker);
      change(tree);

      expect(await savedBeforeRemoval(tree, marker, notes)).toBe(expected);
      expect(readFileSync(path.join(notes, "plan.md"), "utf8")).toBe(note);
    }));
});
