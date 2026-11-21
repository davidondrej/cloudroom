import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
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

  it("keeps the worktree's own ignored files, not what a tool rebuilds", () =>
    withRepo(async (base, repo) => {
      const tree = path.join(base, "tree");
      const notes = path.join(base, "notes");
      git(repo, "worktree", "add", "-q", "-b", "room/task", tree);
      writeFileSync(path.join(tree, ".gitignore"), "node_modules/\n.env\nout/\ntarget/\n");
      writeFileSync(path.join(tree, ".env"), "SECRET=1");
      for (const dir of ["out", "target", "node_modules"]) mkdirSync(path.join(tree, dir));
      writeFileSync(path.join(tree, "out", "report.txt"), "report");
      writeFileSync(path.join(tree, "target", "CACHEDIR.TAG"), "");
      writeFileSync(path.join(tree, "node_modules", "dep.js"), "");

      expect(await saveWorktreeWork(tree, notes, "cloudroom/saved-env", undefined, true)).toBe("room/task");
      git(repo, "worktree", "remove", "--force", tree);
      git(repo, "worktree", "add", "-q", tree, "room/task");
      await restoreWorktreeWork(tree, notes);

      expect(readFileSync(path.join(tree, ".env"), "utf8")).toBe("SECRET=1");
      expect(readFileSync(path.join(tree, "out", "report.txt"), "utf8")).toBe("report");
      expect(existsSync(path.join(tree, "target"))).toBe(false);
      expect(existsSync(path.join(tree, "node_modules"))).toBe(false);
      expect(existsSync(`${notes}.ignored`)).toBe(false);
    }));

  it.skipIf(process.platform === "win32")(
    "skips sockets, and commits nothing when a copy fails",
    () =>
      withRepo(async (base, repo) => {
        const tree = path.join(base, "tree");
        const notes = path.join(base, "notes");
        git(repo, "worktree", "add", "-q", "-b", "room/task", tree);
        writeFileSync(path.join(tree, ".gitignore"), "*.sock\n.env\n");
        writeFileSync(path.join(tree, "draft.txt"), "draft");
        const server = createServer().listen(path.join(tree, "dev.sock"));
        await once(server, "listening");
        try {
          writeFileSync(path.join(tree, ".env"), "SECRET=1");
          chmodSync(path.join(tree, ".env"), 0);
          expect(await saveWorktreeWork(tree, notes, "cloudroom/saved-env", undefined, true)).toBeNull();
          expect(git(tree, "log", "-1", "--format=%s")).toBe("base\n");
          expect(git(tree, "status", "--porcelain").split("\n").sort()).toEqual(["", " M .gitignore", "?? draft.txt"]);

          chmodSync(path.join(tree, ".env"), 0o600);
          expect(await saveWorktreeWork(tree, notes, "cloudroom/saved-env", undefined, true)).toBe("room/task");
          expect(readFileSync(path.join(`${notes}.ignored`, ".env"), "utf8")).toBe("SECRET=1");
          expect(existsSync(path.join(`${notes}.ignored`, "dev.sock"))).toBe(false);
        } finally {
          server.close();
        }
      }),
  );

  it("lets a saved symlink replace a file the rebuild put in its place", () =>
    withRepo(async (base, repo) => {
      const tree = path.join(base, "tree");
      const notes = path.join(base, "notes");
      git(repo, "worktree", "add", "-q", "-b", "room/task", tree);
      writeFileSync(path.join(tree, ".gitignore"), ".env\n");
      symlinkSync("../shared.env", path.join(tree, ".env"));

      expect(await saveWorktreeWork(tree, notes, "cloudroom/saved-env", undefined, true)).toBe("room/task");
      git(repo, "worktree", "remove", "--force", tree);
      git(repo, "worktree", "add", "-q", tree, "room/task");
      writeFileSync(path.join(tree, ".env"), "copied by .worktreeinclude");
      await restoreWorktreeWork(tree, notes);

      expect(readlinkSync(path.join(tree, ".env"))).toBe("../shared.env");
    }));

  it("keeps the folder, uncommitted, when its own ignored files are too big to keep", () =>
    withRepo(async (base, repo) => {
      const tree = path.join(base, "tree");
      git(repo, "worktree", "add", "-q", "-b", "room/task", tree);
      writeFileSync(path.join(tree, ".gitignore"), "data.bin\n");
      writeFileSync(path.join(tree, "data.bin"), "");
      truncateSync(path.join(tree, "data.bin"), 201e6);

      expect(await saveWorktreeWork(tree, path.join(base, "notes"), "cloudroom/saved-env", undefined, true)).toBeNull();
      expect(git(tree, "status", "--porcelain")).toBe(" M .gitignore\n");
      // An archive drops them, as it always did.
      expect(await saveWorktreeWork(tree, path.join(base, "notes"), "cloudroom/saved-env")).toBe("room/task");
      expect(existsSync(path.join(base, "notes.ignored"))).toBe(false);
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
