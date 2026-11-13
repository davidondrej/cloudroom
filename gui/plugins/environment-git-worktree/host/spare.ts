import {
  findWorktreeForBranch,
  runGit,
  type GitCommandResult,
} from "bb-environment-provider-host/git";
import { runGitWithWorktreeMetadataLock } from "bb-environment-provider-host/locks";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SPARE_DIR_PREFIX, sparePathIn, spareReadyPath } from "./paths.js";
import { removeWorktree } from "./worktree.js";

const SPARE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// The app warns about low disk space at the same level.
const LOW_DISK_BYTES = 10e9;
// Git re-reads every file written in the same second as its index, so the
// index is refreshed once the clock has moved on. Without it a claim is slow.
const INDEX_SETTLE_MS = 1500;
// A file watcher started in the spare holds its folder open, and on Windows
// that blocks the move.
const NO_WATCHER = ["-c", "core.fsmonitor=false"];

/** Spares being claimed, built, or removed. Nobody waits: a busy spare is skipped. */
const busy = new Set<string>();
const builds = new Set<Promise<void>>();

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false,
  );
}

async function lowOnDisk(dir: string): Promise<boolean> {
  return fs.statfs(dir).then(
    (disk) => disk.bavail * disk.bsize < LOW_DISK_BYTES,
    () => false,
  );
}

let hookRunSupport: Promise<boolean> | undefined;
/** A claim runs the post-checkout hook itself, which needs `git hook run` (Git 2.36). */
function canRunHooks(cwd: string): Promise<boolean> {
  hookRunSupport ??= runGit(["version"], { cwd }).then(
    ({ stdout }) => {
      const [, major, minor] = /(\d+)\.(\d+)/u.exec(stdout) ?? [];
      return Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 36);
    },
    () => false,
  );
  return hookRunSupport;
}

/** Runs `work` as the spare's only user, or returns null when it already has one. */
async function whileBusy<T>(
  sparePath: string,
  work: () => Promise<T>,
): Promise<T | null> {
  if (busy.has(sparePath)) return null;
  busy.add(sparePath);
  try {
    return await work();
  } finally {
    busy.delete(sparePath);
  }
}

/** `sourcePath` is unknown when cleaning up another checkout's spare. */
async function removeSpare(
  sparePath: string,
  sourcePath: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
): Promise<void> {
  await fs.rm(spareReadyPath(sparePath), { force: true });
  await removeWorktree({ path: sparePath, env });
  // Git still records a folder that was deleted by hand.
  if (sourcePath !== undefined)
    await runGitWithWorktreeMetadataLock(
      ["worktree", "remove", "--force", sparePath],
      { cwd: sourcePath, allowFailure: true, ...(env ? { env } : {}) },
    ).catch(() => undefined);
  await fs.rm(path.dirname(sparePath), { recursive: true, force: true });
}

/** Deletes spares nobody claimed for a week, and every spare when the disk is nearly full. */
export async function removeUnusedSpares(
  worktreesRoot: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const low = await lowOnDisk(worktreesRoot);
  for (const name of await fs.readdir(worktreesRoot).catch(() => [])) {
    if (!name.startsWith(SPARE_DIR_PREFIX)) continue;
    const dir = path.join(worktreesRoot, name);
    await whileBusy(sparePathIn(dir), async () => {
      const { mtimeMs } = await fs.stat(dir);
      if (low || Date.now() - mtimeMs >= SPARE_MAX_AGE_MS)
        await removeSpare(sparePathIn(dir), undefined, env);
    }).catch(() => undefined);
  }
}

/**
 * Moves the prebuilt spare into place and switches it to the new branch.
 * Null when there is no usable spare, so the caller builds a worktree as usual.
 */
export async function claimSpareWorktree(args: {
  sourcePath: string;
  sparePath: string;
  targetPath: string;
  branchName: string;
  startPoint: string;
  signal: AbortSignal;
}): Promise<GitCommandResult | null> {
  const { sourcePath, sparePath, targetPath, signal } = args;
  const result = await whileBusy(sparePath, async () => {
    if (
      !(await canRunHooks(sourcePath)) ||
      // Older Git lets `checkout -B` take a branch another worktree is using.
      (await findWorktreeForBranch(sourcePath, args.branchName)) !== null ||
      !(await fs.unlink(spareReadyPath(sparePath)).then(
        () => true,
        () => false,
      ))
    )
      return null;
    try {
      await runGitWithWorktreeMetadataLock(
        ["worktree", "move", sparePath, targetPath],
        { cwd: sourcePath, signal },
      );
      // No hook runs here: the spare's old path no longer exists, so Git
      // finds none in it.
      return await runGit(
        [
          "-c",
          "checkout.workers=0",
          "-c",
          `core.hooksPath=${sparePath}`,
          "checkout",
          "--force",
          "-B",
          args.branchName,
          args.startPoint,
        ],
        { cwd: targetPath, signal },
      );
    } catch (error) {
      if (signal.aborted) throw error;
      await removeWorktree({ path: targetPath });
      return null;
    }
  });
  if (result === null) return null;
  // The hook runs once, with what `git worktree add` gives it: no previous
  // commit. A failure fails the create, as it does there.
  const head = (
    await runGit(["rev-parse", "HEAD"], { cwd: targetPath, signal })
  ).stdout.trim();
  await runGit(
    [
      "hook",
      "run",
      "--ignore-missing",
      "post-checkout",
      "--",
      "0".repeat(head.length),
      head,
      "1",
    ],
    { cwd: targetPath, signal },
  );
  return result;
}

async function build(args: BuildSpareArgs): Promise<void> {
  const { sourcePath, sparePath, env, signal } = args;
  await removeUnusedSpares(args.worktreesRoot, env);
  await whileBusy(sparePath, async () => {
    if (
      (await exists(spareReadyPath(sparePath))) ||
      // Git cannot move a worktree that has submodules.
      (await exists(path.join(args.worktreePath, ".gitmodules"))) ||
      (await lowOnDisk(args.worktreesRoot)) ||
      !(await canRunHooks(sourcePath))
    )
      return;
    try {
      await removeSpare(sparePath, sourcePath, env);
      await fs.mkdir(path.dirname(sparePath), { recursive: true });
      // Register under the lock, write the files outside it, so a create that
      // arrives meanwhile is not held up. `reset` runs no post-checkout hook.
      await runGitWithWorktreeMetadataLock(
        [
          "worktree",
          "add",
          "--no-checkout",
          "--detach",
          sparePath,
          args.startPoint,
        ],
        { cwd: sourcePath, env, signal },
      );
      await runGit(
        [
          ...NO_WATCHER,
          "-c",
          "checkout.workers=0",
          "reset",
          "--hard",
          "--quiet",
        ],
        { cwd: sparePath, env, signal },
      );
      await delay(INDEX_SETTLE_MS, undefined, { signal });
      await runGit([...NO_WATCHER, "update-index", "-q", "--refresh"], {
        cwd: sparePath,
        env,
        signal,
        allowFailure: true,
      });
      signal.throwIfAborted();
      await fs.writeFile(spareReadyPath(sparePath), "");
    } catch {
      // No signal: the half-built spare is removed even when the worker is stopping.
      await removeSpare(sparePath, sourcePath, env).catch(() => undefined);
    }
  });
}

interface BuildSpareArgs {
  sourcePath: string;
  sparePath: string;
  startPoint: string;
  /** The worktree just created, as a sample of what the checkout contains. */
  worktreePath: string;
  worktreesRoot: string;
  /** The host call's environment, which the worker drops once the call returns. */
  env: NodeJS.ProcessEnv;
  /** Aborted when the worker stops. */
  signal: AbortSignal;
}

/**
 * Prebuilds the next worktree of this checkout, so the next create only moves
 * it into place and switches branch. Best effort and never rejects: a failure
 * leaves no ready marker, and the next create builds its worktree as usual.
 */
export function buildSpareWorktree(args: BuildSpareArgs): Promise<void> {
  const run = build(args)
    .catch(() => undefined)
    .finally(() => builds.delete(run));
  builds.add(run);
  return run;
}

/** Resolves once no build is running; a stopping worker waits on this. */
export async function settleSpareBuilds(): Promise<void> {
  await Promise.all(builds);
}
