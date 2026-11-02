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
 * Commits unfinished work to the worktree's branch (a new `cloudroom/saved-*`
 * branch if HEAD is detached) and copies its ignored `private/` notes to
 * `notesDir`. Returns that branch, or null when the folder must stay.
 */
export async function saveWorktreeWork(
  folder: string,
  notesDir: string,
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
      const sha = (await git(folder, ["rev-parse", "--short", "HEAD"])).trim();
      branch = `cloudroom/saved-${sha}`;
      await git(folder, ["branch", "-f", branch, "HEAD"]);
    }
    if (existsSync(path.join(folder, NOTES)))
      await cp(path.join(folder, NOTES), notesDir, { recursive: true });
    return branch;
  } catch {
    return null;
  }
}

/** Undoes `saveWorktreeWork` in the rebuilt folder: the work is uncommitted again and the notes are back. */
export async function restoreWorktreeWork(
  folder: string,
  notesDir: string,
): Promise<void> {
  if ((await git(folder, ["log", "-1", "--format=%s"])).trim() === SAVE_MESSAGE)
    await git(folder, ["reset", "-q", "HEAD~1"]);
  if (!existsSync(notesDir)) return;
  await cp(notesDir, path.join(folder, NOTES), {
    recursive: true,
    force: false,
  });
  await rm(notesDir, { recursive: true, force: true });
}
