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
import { restoreWorktreeWork, saveWorktreeWork } from "./worktree-work.js";

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

      expect(await saveWorktreeWork(tree, notes)).toBe("room/task");
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

  it("keeps a detached HEAD's work on a new branch", () =>
    withRepo(async (base, repo) => {
      const tree = path.join(base, "tree");
      git(repo, "worktree", "add", "-q", "--detach", tree);
      writeFileSync(path.join(tree, "draft.txt"), "draft");

      const branch = await saveWorktreeWork(tree, path.join(base, "notes"));

      expect(branch).toMatch(/^cloudroom\/saved-/);
      expect(git(repo, "show", `${branch}:draft.txt`)).toBe("draft");
    }));
});
