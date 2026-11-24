import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_ENV_SETUP_SCRIPT_NAME,
  DEFAULT_ENV_TEARDOWN_SCRIPT_NAME,
} from "@cloudroom/domain";
import { runGit } from "@cloudroom/host-workspace";
import {
  ensureDataPrivateDir,
  sanitizeInheritedChildProcessEnv,
} from "@cloudroom/process-utils";
import {
  emitOutput,
  throwIfProvisionAborted,
  type ProgressCallback,
} from "bb-environment-provider-host/transcript";

/**
 * An environment's lifecycle hooks as Cloudroom may run them: read from Git at
 * the environment's base commit when it was first set up, before any agent ran
 * in its folder. The copies in the folder are never run: sandboxed agents can
 * write it, and the hooks run outside every sandbox.
 */
export interface EnvironmentHookScripts {
  /** The commit the scripts were read from; null when none could be read. */
  commit: string | null;
  base: string | null;
  setup: Buffer | null;
  teardown: Buffer | null;
}

const HOOKS_DIR_NAME = "environment-hooks";
const MAX_SCRIPT_BYTES = 1024 * 1024;
const MAX_SYMLINK_HOPS = 5;
const GIT_TIMEOUT_MS = 60_000;
// The repo's refs and objects are shared with sandboxed agents. Reads ignore
// replace refs, never fetch missing objects or use any transport (so no
// transport or credential program starts), and match paths literally.
const GIT_READ_ARGS = ["--no-replace-objects"];
const GIT_READ_ENV = {
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_ALLOW_PROTOCOL: "none",
  GIT_LITERAL_PATHSPECS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
};
// Branches Cloudroom makes from an agent's uncommitted work. Never a hook base.
const AGENT_SNAPSHOT_BRANCH_PREFIX = "cloudroom/";
const ENVIRONMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

const execFileAsync = promisify(execFile);

interface GitReadOptions {
  cwd: string;
  shellPath: string | undefined;
  signal: AbortSignal | undefined;
}

function git(args: string[], options: GitReadOptions) {
  return runGit([...GIT_READ_ARGS, ...args], {
    cwd: options.cwd,
    allowFailure: true,
    env: GIT_READ_ENV,
    timeoutMs: GIT_TIMEOUT_MS,
    ...(options.shellPath !== undefined ? { shellPath: options.shellPath } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
}

async function readBlob(
  oid: string,
  options: GitReadOptions,
): Promise<Buffer | "too-large" | null> {
  const size = await git(["cat-file", "-s", oid], options);
  const bytes = Number.parseInt(size.stdout.trim(), 10);
  if (size.exitCode !== 0 || !Number.isSafeInteger(bytes)) return null;
  if (bytes > MAX_SCRIPT_BYTES) return "too-large";
  const result = await execFileAsync(
    "git",
    [...GIT_READ_ARGS, "cat-file", "blob", oid],
    {
      cwd: options.cwd,
      windowsHide: true,
      encoding: "buffer",
      env: {
        ...sanitizeInheritedChildProcessEnv({
          env: process.env,
          ...(options.shellPath !== undefined
            ? { shellPath: options.shellPath }
            : {}),
        }),
        ...GIT_READ_ENV,
      },
      maxBuffer: MAX_SCRIPT_BYTES + 1,
      timeout: GIT_TIMEOUT_MS,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  ).catch(() => null);
  return result === null ? null : Buffer.from(result.stdout);
}

/** A committed symlink's target inside the repo, or null when it leaves it. */
function symlinkTarget(linkPath: string, target: string): string | null {
  if (
    target.length === 0 ||
    target.includes("\0") ||
    target.includes("\\") ||
    path.posix.isAbsolute(target) ||
    /^[A-Za-z]:/u.test(target)
  )
    return null;
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(linkPath), target),
  );
  if (resolved === ".." || resolved.startsWith("../") || resolved === ".")
    return null;
  return resolved;
}

/** The script as committed at `commit` in the folder at `prefix`, following
 *  in-repo symlinks there; null when there is none to run. */
async function readCommittedScript(
  commit: string,
  prefix: string,
  scriptName: string,
  options: GitReadOptions,
  note: (text: string) => void,
): Promise<Buffer | null> {
  let entryPath = `${prefix}${scriptName}`;
  for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop += 1) {
    const listed = await git(
      ["ls-tree", "-z", "--full-tree", commit, "--", entryPath],
      options,
    );
    if (listed.exitCode !== 0) {
      note(`Skipped ${scriptName}: Git could not list it at ${commit.slice(0, 7)}.`);
      return null;
    }
    const record = listed.stdout.split("\0").find((line) => line.length > 0);
    if (record === undefined) {
      if (hop > 0)
        note(`Skipped ${scriptName}: its link points to ${entryPath}, which isn't committed.`);
      return null;
    }
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.*)$/su.exec(record);
    if (match === null || match[4] !== entryPath) {
      note(`Skipped ${scriptName}: Git listed an unexpected entry for it.`);
      return null;
    }
    const [, mode, type, oid] = match as unknown as [string, string, string, string];
    if (type !== "blob") {
      note(`Skipped ${scriptName}: it is not a file.`);
      return null;
    }
    const contents = await readBlob(oid, options);
    if (contents === "too-large") {
      note(`Skipped ${scriptName}: it is larger than 1 MB.`);
      return null;
    }
    if (contents === null) {
      note(`Skipped ${scriptName}: Git could not read it at ${commit.slice(0, 7)}.`);
      return null;
    }
    if (mode !== "120000") return contents;
    const next = symlinkTarget(entryPath, contents.toString("utf8"));
    if (next === null) {
      note(`Skipped ${scriptName}: it is a link to a path outside the repository.`);
      return null;
    }
    entryPath = next;
  }
  note(`Skipped ${scriptName}: it links through more than ${MAX_SYMLINK_HOPS} links.`);
  return null;
}

async function firstExistingRef(
  candidates: readonly string[],
  options: GitReadOptions,
): Promise<string | null> {
  for (const ref of candidates) {
    const found = await git(
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      options,
    );
    if (found.exitCode === 0 && found.stdout.trim().length > 0) return ref;
  }
  return null;
}

/** The repo's default branch: origin's HEAD, else `main`, else `master`. */
async function defaultBranchName(
  options: GitReadOptions,
): Promise<string | null> {
  const originHead = await git(
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    options,
  );
  const remoteHead = originHead.stdout.trim();
  if (originHead.exitCode === 0 && remoteHead.startsWith("refs/remotes/origin/"))
    return remoteHead.slice("refs/remotes/origin/".length);
  for (const name of ["main", "master"]) {
    if (
      (await firstExistingRef(
        [`refs/heads/${name}`, `refs/remotes/origin/${name}`],
        options,
      )) !== null
    )
      return name;
  }
  return null;
}

/**
 * The full ref of the environment's base branch: a local branch, else a
 * remote-tracking one, as a new worktree starts from it. Full names, so a tag
 * or a file in the Git folder with the same short name never stands in for it,
 * and a commit ID (a moved thread's start) never names one. A base that names
 * no branch, or a branch Cloudroom made from an agent's work, falls back to
 * the default branch.
 */
async function resolveBaseRef(
  baseBranch: string | null,
  options: GitReadOptions,
): Promise<{ name: string; ref: string } | null> {
  if (
    baseBranch !== null &&
    !baseBranch.startsWith(AGENT_SNAPSHOT_BRANCH_PREFIX)
  ) {
    const ref = await firstExistingRef(
      [
        `refs/heads/${baseBranch}`,
        `refs/remotes/${baseBranch}`,
        `refs/remotes/origin/${baseBranch}`,
      ],
      options,
    );
    if (ref !== null) return { name: baseBranch, ref };
  }
  const name = await defaultBranchName(options);
  if (name === null) return null;
  const ref = await firstExistingRef(
    [`refs/heads/${name}`, `refs/remotes/origin/${name}`],
    options,
  );
  return ref === null ? null : { name, ref };
}

function hookScriptsFile(dataDir: string, environmentId: string): string {
  if (!ENVIRONMENT_ID_PATTERN.test(environmentId))
    throw new Error(`Invalid environment ID: ${environmentId}`);
  return path.join(
    ensureDataPrivateDir(dataDir, HOOKS_DIR_NAME),
    `${environmentId}.json`,
  );
}

export async function saveEnvironmentHookScripts(
  dataDir: string,
  environmentId: string,
  scripts: EnvironmentHookScripts,
): Promise<void> {
  const file = hookScriptsFile(dataDir, environmentId);
  const temp = `${file}.${randomUUID()}.tmp`;
  const encode = (script: Buffer | null) =>
    script === null ? null : script.toString("base64");
  try {
    await fs.writeFile(
      temp,
      JSON.stringify({
        version: 1,
        commit: scripts.commit,
        base: scripts.base,
        setup: encode(scripts.setup),
        teardown: encode(scripts.teardown),
      }),
      { mode: 0o600, flag: "wx" },
    );
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

/** The hooks saved for this environment, or null when it has none saved (it was set up before Cloudroom saved them). */
export async function readEnvironmentHookScripts(
  dataDir: string,
  environmentId: string,
): Promise<EnvironmentHookScripts | null> {
  let raw: string;
  try {
    raw = await fs.readFile(hookScriptsFile(dataDir, environmentId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const decode = (value: unknown) =>
    typeof value === "string" ? Buffer.from(value, "base64") : null;
  if (parsed.version !== 1)
    throw new Error(`Unknown saved hooks version for ${environmentId}`);
  return {
    commit: text(parsed.commit),
    base: text(parsed.base),
    setup: decode(parsed.setup),
    teardown: decode(parsed.teardown),
  };
}

export async function removeEnvironmentHookScripts(
  dataDir: string,
  environmentId: string,
): Promise<void> {
  await fs.rm(hookScriptsFile(dataDir, environmentId), { force: true });
}

/**
 * Reads the environment's hooks from Git at the merge base of its HEAD and its
 * base branch, saves them in the data folder, and returns them. Run it at the
 * environment's first setup, before any agent runs in the folder. For a new
 * worktree the merge base is its start commit; for a fork or a move it is
 * where the source branched off, so files the source had not committed, files
 * carried or copied in, and the source agent's own commits never count.
 */
export async function captureEnvironmentHookScripts(args: {
  dataDir: string;
  environmentId: string;
  workspacePath: string;
  baseBranch: string | null;
  shellPath?: string;
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
}): Promise<EnvironmentHookScripts> {
  // Read once per environment. A replayed or retried setup runs the same
  // scripts, and teardown keeps the one that matches what setup made.
  const saved = await readEnvironmentHookScripts(
    args.dataDir,
    args.environmentId,
  );
  if (saved !== null) return saved;
  const options: GitReadOptions = {
    cwd: args.workspacePath,
    shellPath: args.shellPath,
    signal: args.signal,
  };
  let noteIndex = 0;
  const note = (text: string) => {
    noteIndex += 1;
    emitOutput(args.onProgress, `hooks-note-${noteIndex}`, text);
  };
  const none = async (base: string | null, reason: string) => {
    if (await hasWorkspaceHook(args.workspacePath))
      note(`Skipped ${DEFAULT_ENV_SETUP_SCRIPT_NAME} and ${DEFAULT_ENV_TEARDOWN_SCRIPT_NAME}: ${reason}`);
    const scripts = { commit: null, base, setup: null, teardown: null };
    await saveEnvironmentHookScripts(args.dataDir, args.environmentId, scripts);
    return scripts;
  };

  throwIfProvisionAborted(args.signal);
  const inside = await git(
    ["rev-parse", "--is-inside-work-tree", "--show-prefix"],
    options,
  );
  const [insideWorkTree, prefix = ""] = inside.stdout
    .split("\n")
    .map((line) => line.replace(/\r$/u, ""));
  if (inside.exitCode !== 0 || insideWorkTree !== "true")
    return none(null, "this folder is not a Git checkout, and Cloudroom runs them only as committed.");
  const base = await resolveBaseRef(args.baseBranch, options);
  if (base === null)
    return none(
      args.baseBranch,
      `Cloudroom could not find ${args.baseBranch ?? "the default branch"} or the default branch to read them from.`,
    );
  const mergeBase = await git(["merge-base", "HEAD", base.ref], options);
  const commit = mergeBase.stdout.trim();
  if (mergeBase.exitCode !== 0 || !/^[0-9a-f]{40,64}$/u.test(commit))
    return none(base.name, `this checkout shares no commit with ${base.name}.`);

  throwIfProvisionAborted(args.signal);
  const scripts: EnvironmentHookScripts = {
    commit,
    base: base.name,
    // At the folder's own path in the repo, where the hooks were looked for before.
    setup: await readCommittedScript(commit, prefix, DEFAULT_ENV_SETUP_SCRIPT_NAME, options, note),
    teardown: await readCommittedScript(commit, prefix, DEFAULT_ENV_TEARDOWN_SCRIPT_NAME, options, note),
  };
  await noteChangedCopy({
    workspacePath: args.workspacePath,
    scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
    committed: scripts.setup,
    at: `${commit.slice(0, 7)} on ${base.name}`,
    note,
  });
  throwIfProvisionAborted(args.signal);
  await saveEnvironmentHookScripts(args.dataDir, args.environmentId, scripts);
  return scripts;
}

async function hasWorkspaceHook(workspacePath: string): Promise<boolean> {
  for (const name of [DEFAULT_ENV_SETUP_SCRIPT_NAME, DEFAULT_ENV_TEARDOWN_SCRIPT_NAME]) {
    if (await fs.lstat(path.join(workspacePath, name)).then(() => true, () => false))
      return true;
  }
  return false;
}

/** Says so when the folder's copy differs from the one that runs, so a changed hook isn't silently ignored. */
async function noteChangedCopy(args: {
  workspacePath: string;
  scriptName: string;
  committed: Buffer | null;
  at: string;
  note: (text: string) => void;
}): Promise<void> {
  const file = path.join(args.workspacePath, args.scriptName);
  if ((await fs.lstat(file).catch(() => null)) === null) return;
  const local = await readSmallRegularFile(file);
  if (args.committed !== null && local !== null && local.equals(args.committed))
    return;
  args.note(
    args.committed === null
      ? `Skipped ${args.scriptName}: it isn't committed at ${args.at}. Cloudroom runs hooks only as committed on the branch the environment starts from.`
      : `Running ${args.scriptName} as committed at ${args.at}, not the changed copy in this folder.`,
  );
}

/** The file's bytes when it is a regular file of at most 1 MiB; null for a
 *  link, a pipe or a device (which may be anything, or block), or a big file. */
async function readSmallRegularFile(file: string): Promise<Buffer | null> {
  const flags =
    fs.constants.O_RDONLY |
    (fs.constants.O_NOFOLLOW ?? 0) |
    (fs.constants.O_NONBLOCK ?? 0);
  const handle = await fs.open(file, flags).catch(() => null);
  if (handle === null) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SCRIPT_BYTES) return null;
    const buffer = Buffer.alloc(MAX_SCRIPT_BYTES + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0 || (length += bytesRead) === buffer.length) break;
    }
    return length > MAX_SCRIPT_BYTES ? null : buffer.subarray(0, length);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
