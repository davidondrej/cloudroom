import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

export const STALE_WORK_MS = 30 * 24 * 60 * 60_000;
const execGit = promisify(execFile);
const STATUS = [
  "status",
  "--porcelain",
  "--untracked-files=all",
  "--ignore-submodules=none",
];

async function git(
  folder: string,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  const options = {
    timeout: 60_000,
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  };
  return (await execGit("git", ["-C", folder, ...args], options)).stdout;
}

async function headReachableFrom(folder: string, refs: string) {
  const count = await git(folder, ["rev-list", "--count", "HEAD", "--not", refs]);
  return count.trim() === "0";
}

/**
 * Removing the folder loses nothing: no uncommitted changes, and HEAD's
 * commits are on a remote (with no remote, on a local branch, which stays).
 */
export async function worktreeHasNoWork(folder: string): Promise<boolean> {
  if (!existsSync(folder)) return true;
  try {
    const [changes, remotes] = await Promise.all([
      git(folder, STATUS),
      git(folder, ["remote"]),
    ]);
    if (changes !== "") return false;
    return headReachableFrom(
      folder,
      remotes.trim() === "" ? "--branches" : "--remotes",
    );
  } catch {
    return false;
  }
}

/** Newest of HEAD's commit time and the changed files' modification times. */
async function lastTouchedAt(folder: string): Promise<number> {
  let latest =
    Number((await git(folder, ["log", "-1", "--format=%ct", "HEAD"])).trim()) *
    1000;
  const entries = (await git(folder, [...STATUS, "-z"])).split("\0");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.length < 4) continue;
    if (/[RC]/.test(entry.slice(0, 2))) index++; // skip the rename source
    try {
      latest = Math.max(
        latest,
        statSync(path.join(folder, entry.slice(3))).mtimeMs,
      );
    } catch {}
  }
  return latest;
}

/**
 * No work to lose, or work untouched for 30 days: then it is committed to the
 * worktree's branch (a new `cloudroom/saved-*` branch if HEAD is detached),
 * dated when it was last touched so later checks still see it as stale.
 */
export async function worktreeCanBeRemoved(
  folder: string,
  now = Date.now(),
): Promise<boolean> {
  if (await worktreeHasNoWork(folder)) return true;
  try {
    const touchedAt = await lastTouchedAt(folder);
    if (now - touchedAt < STALE_WORK_MS) return false;
    if ((await git(folder, STATUS)) !== "") {
      const date = `@${Math.floor(touchedAt / 1000)} +0000`;
      await git(folder, ["add", "-A"]);
      await git(
        folder,
        [
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
          "Cloudroom: save work from a worktree unused for 30 days before removing it",
        ],
        { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      );
    }
    const detached = await git(folder, ["symbolic-ref", "-q", "HEAD"]).then(
      () => false,
      () => true,
    );
    if (detached) {
      const sha = (await git(folder, ["rev-parse", "--short", "HEAD"])).trim();
      await git(folder, ["branch", "-f", `cloudroom/saved-${sha}`, "HEAD"]);
    }
    return (
      (await git(folder, STATUS)) === "" &&
      (await headReachableFrom(folder, "--branches"))
    );
  } catch {
    return false;
  }
}
