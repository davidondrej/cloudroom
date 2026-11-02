import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execGit = promisify(execFile);
const SAVE_MESSAGE =
  "Cloudroom: save unfinished work before removing the worktree";
const NOTES = "private";
const STATUS = [
  "status",
  "--porcelain",
  "--untracked-files=all",
  "--ignore-submodules=none",
];

async function git(folder: string, args: string[]): Promise<string> {
  return (
    await execGit("git", ["-C", folder, ...args], { timeout: 60_000 })
  ).stdout;
}

/**
 * Commits unfinished work to the worktree's branch and copies its ignored
 * `private/` notes to `notesDir`. Returns that branch, or null when the folder
 * must stay. A detached HEAD moves onto `detachedBranch`, which must be unique
 * to this worktree: rebuilding on a branch removes any clean worktree holding it.
 */
export async function saveWorktreeWork(
  folder: string,
  notesDir: string,
  detachedBranch: string,
): Promise<string | null> {
  try {
    if ((await git(folder, STATUS)) !== "") {
      await git(folder, ["add", "-A"]);
      await git(folder, [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Cloudroom",
        "-c",
        "user.email=cloudroom@localhost",
        "commit",
        "--no-verify",
        "-q",
        "-m",
        SAVE_MESSAGE,
      ]);
    }
    if ((await git(folder, STATUS)) !== "") return null;
    let branch = (await git(folder, ["branch", "--show-current"])).trim();
    if (branch === "") {
      branch = detachedBranch;
      await git(folder, ["branch", "-f", branch, "HEAD"]);
      await git(folder, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    }
    if (existsSync(path.join(folder, NOTES)))
      await cp(path.join(folder, NOTES), notesDir, { recursive: true });
    return branch;
  } catch {
    return null;
  }
}

/** Undoes `saveWorktreeWork` in the rebuilt folder: the work is uncommitted again and the saved notes replace any copies the rebuild made. */
export async function restoreWorktreeWork(
  folder: string,
  notesDir: string,
): Promise<void> {
  if ((await git(folder, ["log", "-1", "--format=%s"])).trim() === SAVE_MESSAGE)
    await git(folder, ["reset", "-q", "HEAD~1"]);
  if (!existsSync(notesDir)) return;
  await cp(notesDir, path.join(folder, NOTES), { recursive: true });
  await rm(notesDir, { recursive: true, force: true });
}
