import { runGit } from "bb-environment-provider-host/git";
import {
  emitOutput,
  emitStep,
  throwIfProvisionAborted,
  type ProgressCallback,
} from "bb-environment-provider-host/transcript";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchRemoteBaseBranch, resolveRemoteBaseBranch } from "./worktree.js";

// The composer fetches when it opens, and people type for longer than 30s,
// so a shorter window would rarely skip. A worktree may start this far behind.
const FRESH_MS = 5 * 60_000;
const WAIT_MS = 2_000;
// A fetch still running after this stops counting as running, even if git
// never exits, so it can't hold the worker forever.
const GIVE_UP_MS = 90_000;
const SLOW = Symbol("slow");
// A fetch that may finish in the background must never ask for a login. The
// app's own background fetch uses the same settings.
const NO_PROMPT = {
  GIT_ASKPASS: "false",
  SSH_ASKPASS: "false",
  SSH_ASKPASS_REQUIRE: "never",
  GCM_INTERACTIVE: "never",
};

/** Lets work outlive the host call that started it. */
export interface BackgroundWork {
  /** Keeps the worker alive until `work` settles. `work` must never reject. */
  keep(work: Promise<unknown>): void;
  /** The call's environment, which the worker drops once the call returns. */
  env: NodeJS.ProcessEnv;
  /** Aborted when the worker stops. */
  signal: AbortSignal;
}

/** One fetch per checkout and branch; it settles with null, or with its error. */
const running = new Map<string, Promise<unknown>>();

/** Compares remote URLs the way Git writes them in FETCH_HEAD: no user, then no trailing `/`, `.git`, `/`. */
function normalizeUrl(url: string): string {
  return url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/iu, "$1")
    .replace(/^[^/:@]+@(?=[^/:]+:)/u, "")
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "")
    .replace(/\/+$/u, "");
}

/** When this branch was last fetched from this remote, and the commit it got. */
async function lastFetch(
  sourcePath: string,
  remote: string,
  branch: string,
  signal: AbortSignal,
): Promise<{ at: number; commit: string } | null> {
  try {
    const [fetchHead, url] = await Promise.all(
      [
        ["rev-parse", "--git-path", "FETCH_HEAD"],
        ["remote", "get-url", remote],
      ].map(async (args) =>
        (await runGit(args, { cwd: sourcePath, signal })).stdout.trim(),
      ),
    );
    const file = path.resolve(sourcePath, fetchHead!);
    const [contents, stat] = await Promise.all([
      fs.readFile(file, "utf8"),
      fs.stat(file),
    ]);
    // The last entry wins, for `git fetch --append`.
    for (const line of contents.split(/\r?\n/u).reverse()) {
      const [commit, , source = ""] = line.split("\t");
      const match = /^branch '(.+)' of (.+)$/u.exec(source);
      if (
        commit &&
        match?.[1] === branch &&
        normalizeUrl(match[2]!) === normalizeUrl(url!)
      )
        return { at: stat.mtimeMs, commit };
    }
  } catch {
    // No FETCH_HEAD yet, or no URL: treat the branch as never fetched.
  }
  return null;
}

/** Fresh: fetched under 5 minutes ago, and the local copy is what that fetch got. */
async function freshness(
  sourcePath: string,
  remote: string,
  branch: string,
  signal: AbortSignal,
): Promise<{ age: number | null; cached: string | null; fresh: boolean }> {
  const [last, cached] = await Promise.all([
    lastFetch(sourcePath, remote, branch, signal),
    runGit(
      [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/remotes/${remote}/${branch}^{commit}`,
      ],
      { cwd: sourcePath, signal, allowFailure: true },
    ).then((result) => result.stdout.trim() || null),
  ]);
  const age = last === null ? null : Date.now() - last.at;
  const fresh =
    age !== null && age >= 0 && age < FRESH_MS && last?.commit === cached;
  return { age, cached, fresh };
}

/** `work`'s result, or an error once `ms` passes. */
function settleWithin(work: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise((resolve) => {
    timer = setTimeout(
      () =>
        resolve(new Error(`git fetch was still running after ${ms / 1000}s`)),
      ms,
    );
  });
  return Promise.race([work, gaveUp]).finally(() => clearTimeout(timer));
}

function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** The fetch's result (null for success, else its error), or SLOW once `waitMs` passes or the create is cancelled. */
async function waitForFetch(
  fetch: Promise<unknown>,
  waitMs: number | null,
  signal: AbortSignal,
): Promise<unknown> {
  const stop = new AbortController();
  const timer =
    waitMs === null ? undefined : setTimeout(() => stop.abort(), waitMs);
  const cancel = () => stop.abort();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await Promise.race([
      fetch,
      new Promise((resolve) =>
        stop.signal.addEventListener("abort", () => resolve(SLOW), {
          once: true,
        }),
      ),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}

/**
 * Brings `origin/<branch>` up to date without making a create wait on the
 * network: skips a recent fetch, waits at most 2s for a new one (which then
 * finishes in the background), and starts from the last fetched copy when the
 * remote can't be reached. Waits in full only when there is no copy yet.
 */
export async function refreshRemoteBase(args: {
  sourcePath: string;
  baseBranch: string;
  background: BackgroundWork;
  onProgress: ProgressCallback | undefined;
  signal: AbortSignal;
}): Promise<void> {
  const { sourcePath, baseBranch, background, onProgress, signal } = args;
  const remoteBase = await resolveRemoteBaseBranch(
    sourcePath,
    baseBranch,
    signal,
  );
  if (remoteBase === null) return;
  const { remote, branch } = remoteBase;
  const { age, cached, fresh } = await freshness(
    sourcePath,
    remote,
    branch,
    signal,
  );
  const step = (text: string, startedAt = Date.now()) =>
    emitStep({
      onProgress,
      key: "git-fetch-completed",
      text,
      status: "completed",
      startedAt,
      metadata: { durationMs: Date.now() - startedAt },
    });
  if (fresh && age !== null) {
    step(`Using ${baseBranch}, fetched ${formatAge(age)}`);
    return;
  }

  // A cancelled create must not leave a fetch running.
  throwIfProvisionAborted(signal);
  const key = `${path.resolve(sourcePath)}\0${remote}\0${branch}`;
  let fetch = running.get(key);
  if (fetch === undefined) {
    const started = settleWithin(
      fetchRemoteBaseBranch({
        sourcePath,
        baseBranch,
        onProgress: undefined,
        signal: background.signal,
        env:
          cached === null
            ? background.env
            : { ...background.env, ...NO_PROMPT },
        // The app's own fetch may have finished while this one waited for
        // the lock; then there's nothing left to fetch.
        skipIf: async () =>
          (await freshness(sourcePath, remote, branch, background.signal))
            .fresh,
      }).then(
        (outcome) =>
          outcome === "fetched" || outcome === "none" ? null : outcome,
        (error: unknown) => error ?? new Error(`git fetch ${remote} failed`),
      ),
      GIVE_UP_MS,
    );
    fetch = started;
    running.set(key, started);
    void started.then(() => {
      if (running.get(key) === started) running.delete(key);
    });
    background.keep(started);
  }

  const startedAt = Date.now();
  emitStep({
    onProgress,
    key: "git-fetch-started",
    text: `Fetching ${baseBranch}`,
    status: "started",
    startedAt,
  });
  const result = await waitForFetch(
    fetch,
    cached === null ? null : WAIT_MS,
    signal,
  );
  throwIfProvisionAborted(signal);
  if (result === null) return step(`Fetched ${baseBranch}`, startedAt);
  if (result === "local") return step(`Using local ${baseBranch}`, startedAt);
  if (result === "fresh")
    return step(`Using ${baseBranch}, fetched just now`, startedAt);
  // Nothing to start from yet: fail as before.
  if (cached === null) throw result;
  const copy = `the copy fetched ${age === null || age < 0 ? "earlier" : formatAge(age)}`;
  if (result === SLOW) {
    step(
      `Still fetching ${baseBranch}, so this starts from ${copy}`,
      startedAt,
    );
    return;
  }
  const message = result instanceof Error ? result.message : String(result);
  // Git's own reason, not the advice it prints after it.
  const reason = /(?:fatal|error): [^\n]*/u.exec(message)?.[0];
  emitOutput(onProgress, "git-fetch-error", reason ?? message.split("\n")[0]!);
  step(`Couldn't fetch ${baseBranch}, so this starts from ${copy}`, startedAt);
}
