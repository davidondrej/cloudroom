import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
// More missing tracked files than an agent plausibly deletes: the folder is
// half removed (a cut-off removal being retried) or half checked out.
// Committing that would replace the branch's tree (#1068).
const MASS_DELETION_FILES = 50;

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
 * `onMassDeletion` hears how many tracked files are gone when that keeps it.
 */
export async function saveWorktreeWork(
  folder: string,
  notesDir: string,
  detachedBranch: string,
  onMassDeletion?: (deletedFiles: number) => void,
): Promise<string | null> {
  try {
    const status = await git(folder, STATUS);
    const deleted = status
      .split("\n")
      .filter((line) => line.slice(0, 2).includes("D")).length;
    if (deleted > MASS_DELETION_FILES) {
      onMassDeletion?.(deleted);
      return null;
    }
    if (status !== "") {
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
    await backUpNotes(folder, notesDir);
    return branch;
  } catch {
    return null;
  }
}

async function backUpNotes(folder: string, notesDir: string): Promise<void> {
  if (existsSync(path.join(folder, NOTES)))
    await cp(path.join(folder, NOTES), notesDir, { recursive: true });
}

/** Records the saved HEAD in `marker` before the folder's removal starts. */
export async function markRemovalStarted(
  folder: string,
  marker: string,
): Promise<void> {
  const head = (await git(folder, ["rev-parse", "HEAD"])).trim();
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, head);
}

/**
 * The saved branch when a cut-off removal is retried: HEAD is still the one
 * `marker` holds and the only changes are tracked files the removal deleted,
 * so saving again would only commit those deletions (#1068). The ignored
 * notes may still have changed, so they are backed up again. Otherwise null.
 */
export async function savedBeforeRemoval(
  folder: string,
  marker: string,
  notesDir: string,
): Promise<string | null> {
  try {
    const saved = (await readFile(marker, "utf8")).trim();
    const status = (await git(folder, STATUS)).split("\n");
    if (status.some((line) => line !== "" && !line.startsWith(" D")))
      return null;
    if ((await git(folder, ["rev-parse", "HEAD"])).trim() !== saved)
      return null;
    const branch = (await git(folder, ["branch", "--show-current"])).trim();
    if (branch === "") return null;
    await backUpNotes(folder, notesDir);
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
