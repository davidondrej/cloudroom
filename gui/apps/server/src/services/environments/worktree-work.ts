import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gitSafetyArgs } from "@cloudroom/host-workspace";

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
// Ignored folders a tool installs or builds again. Never a common name like
// `dist`, `build` or `target`: those go only when a tool tagged them a cache.
const REBUILT = new Set([
  "node_modules",
  ".venv",
  ".next",
  ".turbo",
  ".pnpm-store",
  "__pycache__",
]);
const CACHE_TAG = "CACHEDIR.TAG";
// The most a worktree's own ignored files may hold and still be kept.
const MAX_OWN_IGNORED_BYTES = 200e6;
// A clone where the disk can make one, so keeping a file costs no space twice.
// Sockets and pipes can't be copied (`ERR_FS_CP_SOCKET`), so they are skipped.
const COPY = {
  recursive: true,
  verbatimSymlinks: true,
  mode: constants.COPYFILE_FICLONE,
  filter: async (source: string) => {
    const stat = await lstat(source);
    return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink();
  },
};

/** Where a parked worktree's own ignored files wait, next to its notes. */
export const ownIgnoredDir = (notesDir: string) => `${notesDir}.ignored`;

async function git(folder: string, args: string[]): Promise<string> {
  // Big enough that a long list of ignored files is never cut off.
  return (
    await execGit("git", [...gitSafetyArgs(), "-C", folder, ...args], {
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout;
}

/**
 * The ignored files that are the worktree's own, like a hand-made `.env`: all
 * but `private/`, what a tool rebuilds, and tagged caches. Null when they
 * hold more than `MAX_OWN_IGNORED_BYTES`.
 */
async function ownIgnoredFiles(folder: string): Promise<string[] | null> {
  const listed = await git(folder, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "-z",
  ]);
  const own = listed
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.replace(/\/$/u, ""))
    .filter(
      (entry) =>
        entry !== NOTES &&
        !REBUILT.has(path.basename(entry)) &&
        !existsSync(path.join(folder, entry, CACHE_TAG)),
    );
  let bytes = 0;
  const pending = own.map((entry) => path.join(folder, entry));
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    const stat = await lstat(file);
    if (stat.isDirectory()) {
      const inside = file;
      pending.push(
        ...(await readdir(inside)).map((name) => path.join(inside, name)),
      );
    } else if ((bytes += stat.size) > MAX_OWN_IGNORED_BYTES) return null;
  }
  return own;
}

/**
 * Commits unfinished work to the worktree's branch and copies its ignored
 * `private/` notes to `notesDir`, and its other own ignored files next to it.
 * Returns that branch, or null when the folder must stay. A detached HEAD,
 * or a branch another worktree has checked out, moves onto `detachedBranch`,
 * which must be unique to this worktree: rebuilding on a branch removes any
 * clean worktree holding it.
 * `onMassDeletion` hears how many tracked files are gone when that keeps it.
 * Own ignored files too big to keep are dropped, or keep the folder with
 * `mustKeepIgnored`.
 */
export async function saveWorktreeWork(
  folder: string,
  notesDir: string,
  detachedBranch: string,
  onMassDeletion?: (deletedFiles: number) => void,
  mustKeepIgnored = false,
): Promise<string | null> {
  let committed = false;
  try {
    const own = await ownIgnoredFiles(folder).catch(() => null);
    if (own === null && mustKeepIgnored) return null;
    const status = await git(folder, STATUS);
    const deleted = status
      .split("\n")
      .filter((line) => line.slice(0, 2).includes("D")).length;
    if (deleted > MASS_DELETION_FILES) {
      onMassDeletion?.(deleted);
      return null;
    }
    // Copies first: if one fails, nothing was committed yet.
    await backUpNotes(folder, notesDir, own);
    let branch = (await git(folder, ["branch", "--show-current"])).trim();
    // A branch another worktree also has checked out would move under that
    // worktree too, so the work goes to the unique branch instead (#2415).
    const holders = (await git(folder, ["worktree", "list", "--porcelain"]))
      .split("\n")
      .filter((line) => line === `branch refs/heads/${branch}`).length;
    if (branch === "" || holders > 1) {
      branch = detachedBranch;
      await git(folder, ["branch", "-f", branch, "HEAD"]);
      await git(folder, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
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
      committed = true;
    }
    if ((await git(folder, STATUS)) !== "") throw new Error("Still changing");
    return branch;
  } catch {
    // The folder stays, so only this save's commit is undone. Earlier copies
    // may belong to a cut-off removal, so they stay too.
    if (committed)
      await git(folder, ["reset", "-q", "HEAD~1"]).catch(() => undefined);
    return null;
  }
}

/**
 * Undoes `saveWorktreeWork` in a whole folder that stays: its work is
 * uncommitted again and the copies are deleted. Nothing is copied back over
 * the folder. Never for a half-removed folder: its copies are the only ones.
 */
export async function undoWorktreeSave(
  folder: string,
  notesDir: string,
): Promise<void> {
  if ((await git(folder, ["log", "-1", "--format=%s"])).trim() === SAVE_MESSAGE)
    await git(folder, ["reset", "-q", "HEAD~1"]);
  for (const dir of [notesDir, ownIgnoredDir(notesDir)])
    await rm(dir, { recursive: true, force: true });
}

/** `own` replaces the kept ignored files: null keeps none, undefined leaves the earlier ones. */
async function backUpNotes(
  folder: string,
  notesDir: string,
  own?: string[] | null,
): Promise<void> {
  if (existsSync(path.join(folder, NOTES)))
    await cp(path.join(folder, NOTES), notesDir, COPY);
  if (own === undefined) return;
  const kept = ownIgnoredDir(notesDir);
  await rm(kept, { recursive: true, force: true });
  for (const entry of own ?? [])
    await cp(path.join(folder, entry), path.join(kept, entry), COPY);
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

/** Copies `from` onto `to`, replacing whatever is in the way: the saved copy wins. */
async function copyOver(from: string, to: string): Promise<void> {
  if (!(await lstat(from)).isDirectory()) {
    await rm(to, { recursive: true, force: true });
    await cp(from, to, COPY);
    return;
  }
  const there = await lstat(to).catch(() => null);
  if (there !== null && !there.isDirectory()) await rm(to, { force: true });
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from))
    await copyOver(path.join(from, name), path.join(to, name));
}

/** Undoes `saveWorktreeWork` in the rebuilt folder: the work is uncommitted again and the saved notes and ignored files replace any copies the rebuild made. */
export async function restoreWorktreeWork(
  folder: string,
  notesDir: string,
): Promise<void> {
  if ((await git(folder, ["log", "-1", "--format=%s"])).trim() === SAVE_MESSAGE)
    await git(folder, ["reset", "-q", "HEAD~1"]);
  for (const [saved, target] of [
    [notesDir, path.join(folder, NOTES)],
    [ownIgnoredDir(notesDir), folder],
  ] as const) {
    if (!existsSync(saved)) continue;
    await copyOver(saved, target);
    await rm(saved, { recursive: true, force: true });
  }
}
