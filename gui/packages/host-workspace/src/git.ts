import { execFile, spawn, type ExecFileException } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gitSafetyArgs } from "bb-environment-provider-host/git";
import {
  createGitBranchQueries,
  resolvePreferredLocalDefaultBranch,
} from "bb-environment-provider-host/git-branches";
import {
  PLAIN_NON_GIT_DIRECTORY_REASON,
  type GitCheckoutRef,
  type WorkspaceGitOperation,
} from "@cloudroom/domain";
import {
  killProcessGroup,
  pathExists,
  sanitizeInheritedChildProcessEnv,
  supportsProcessGroups,
} from "@cloudroom/process-utils";

const execFileAsync = promisify(execFile);
const DEFAULT_BUFFER_BYTES = 16 * 1024 * 1024;

export class WorkspaceError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "WorkspaceError";
  }
}

export interface GitProcessOptions {
  shellPath?: string;
}

export interface RunGitOptions extends GitProcessOptions {
  cwd: string;
  timeoutMs?: number;
  allowFailure?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxBufferBytes?: number;
  allowTruncatedStdout?: boolean;
  onStderr?: (chunk: string) => void;
  /** Runs hooks, as the user's own `git clone` would. */
  hooks?: boolean;
}

interface ResolveGitProcessEnvArgs {
  env: NodeJS.ProcessEnv | undefined;
  shellPath: string | undefined;
}

interface GitTimeoutOptions extends GitProcessOptions {
  timeoutMs?: number;
}

interface FetchRemoteBranchesResult {
  status: "fetched" | "failed" | "skipped";
}

interface FetchRemoteBranchesOptions extends GitTimeoutOptions {
  interactive: boolean;
}

interface BranchRefsWithDefaults {
  branches: string[];
  defaultBranch: string | undefined;
  originDefaultBranch: string | undefined;
  remoteBranches: string[];
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type ActiveWorkspaceGitOperationKind = Exclude<
  WorkspaceGitOperation["kind"],
  "none" | "unknown"
>;

interface PorcelainEntry {
  path: string;
  status: string;
  indexStatus: string;
  worktreeStatus: string;
}

interface WorkspaceGitOperationMarker {
  kind: ActiveWorkspaceGitOperationKind;
  markerNames: string[];
}

interface ParsedPorcelainPathToken {
  nextIndex: number;
  value: string;
}

const CONFLICT_PORCELAIN_STATUSES = new Set<string>([
  "DD",
  "AU",
  "UD",
  "UA",
  "DU",
  "AA",
  "UU",
]);

const WORKSPACE_GIT_OPERATION_MARKERS: WorkspaceGitOperationMarker[] = [
  { kind: "rebase", markerNames: ["rebase-merge", "rebase-apply"] },
  { kind: "merge", markerNames: ["MERGE_HEAD"] },
  { kind: "cherry-pick", markerNames: ["CHERRY_PICK_HEAD"] },
  { kind: "revert", markerNames: ["REVERT_HEAD"] },
];

const GIT_QUOTED_PATH_ESCAPE_BYTES = new Map<string, number>([
  ['"', 34],
  ["\\", 92],
  ["a", 7],
  ["b", 8],
  ["f", 12],
  ["n", 10],
  ["r", 13],
  ["t", 9],
  ["v", 11],
]);

function toExecError(error: unknown): ExecFileException | undefined {
  if (error instanceof Error) {
    return error as ExecFileException;
  }
  return undefined;
}

function trimOutput(value: string): string {
  return value.trim().replace(/\n+$/u, "");
}

function getExitCode(error: ExecFileException | undefined): number {
  if (typeof error?.code === "number") {
    return error.code;
  }
  return 1;
}

function resolveGitProcessEnv(
  args: ResolveGitProcessEnvArgs,
): NodeJS.ProcessEnv {
  return {
    ...sanitizeInheritedChildProcessEnv({
      env: process.env,
      ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
    }),
    ...args.env,
  };
}

function isMaxBufferExceededError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
  );
}

function isStdoutMaxBufferExceededError(error: unknown): boolean {
  return (
    isMaxBufferExceededError(error) &&
    error instanceof Error &&
    error.message.includes("stdout maxBuffer")
  );
}

function readCommandTimeoutMs(
  error: ExecFileException | undefined,
  timeoutMs: number | undefined,
): number | null {
  if (
    typeof timeoutMs === "number" &&
    error?.killed === true &&
    error.signal === "SIGTERM"
  ) {
    return timeoutMs;
  }
  return null;
}

function isMissingGitBlobTargetError(stderr: string): boolean {
  return (
    /^fatal: path '.+' does not exist in '.+'$/u.test(stderr) ||
    /^fatal: invalid object name '.+'\.$/u.test(stderr) ||
    /^fatal: Not a valid object name .+$/u.test(stderr)
  );
}

function createGitCommandTimedOutError(
  args: string[],
  timeoutMs: number,
  cause?: unknown,
): WorkspaceError {
  return new WorkspaceError(
    "git_command_timeout",
    `git ${args.join(" ")} timed out after ${timeoutMs}ms`,
    { cause },
  );
}

function createGitCommandCancelledError(
  args: string[],
  cause?: unknown,
): WorkspaceError {
  return new WorkspaceError(
    "provision_cancelled",
    `git ${args.join(" ")} was cancelled`,
    { cause },
  );
}

function createGitCommandFailedError(
  args: string[],
  stderr: string,
  cause?: unknown,
): WorkspaceError {
  const detail = stderr ? `: ${stderr}` : "";
  return new WorkspaceError(
    "git_command_failed",
    `git ${args.join(" ")} failed${detail}`,
    { cause },
  );
}

export async function runGit(
  args: string[],
  options: RunGitOptions,
): Promise<GitCommandResult> {
  if (options.signal?.aborted) {
    throw createGitCommandCancelledError(args, options.signal.reason);
  }
  const gitArgs = [...gitSafetyArgs(options.hooks), ...args];
  try {
    const processOptions = {
      cwd: options.cwd,
      encoding: "utf8",
      env: resolveGitProcessEnv({
        env: options.env,
        shellPath: options.shellPath,
      }),
      maxBuffer: options.maxBufferBytes ?? DEFAULT_BUFFER_BYTES,
      signal: options.signal,
      timeout: options.timeoutMs,
      windowsHide: true,
    } as const;
    const stderrListener = options.onStderr;
    const result =
      stderrListener === undefined
        ? await execFileAsync("git", gitArgs, processOptions)
        : await new Promise<{ stdout: string; stderr: string }>(
            (resolve, reject) => {
              const child = execFile(
                "git",
                gitArgs,
                processOptions,
                (error, stdout, stderr) => {
                  if (error) {
                    error.stdout = stdout;
                    error.stderr = stderr;
                    reject(error);
                  } else resolve({ stdout, stderr });
                },
              );
              child.stderr?.setEncoding("utf8");
              child.stderr?.on("data", stderrListener);
            },
          );
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
    };
  } catch (error) {
    if (options.signal?.aborted) {
      throw createGitCommandCancelledError(args, error);
    }
    const execError = toExecError(error);
    const timeoutMs = readCommandTimeoutMs(execError, options.timeoutMs);
    if (timeoutMs !== null) {
      throw createGitCommandTimedOutError(args, timeoutMs, error);
    }
    if (
      options.allowTruncatedStdout === true &&
      isStdoutMaxBufferExceededError(error)
    ) {
      return {
        stdout: execError?.stdout ?? "",
        stderr: execError?.stderr ?? "",
        exitCode: 0,
      };
    }
    if (options.allowFailure) {
      return {
        stdout: execError?.stdout ?? "",
        stderr: execError?.stderr ?? "",
        exitCode: getExitCode(execError),
      };
    }

    const stderr = trimOutput(execError?.stderr ?? "");
    const detail = stderr ? `: ${stderr}` : "";
    throw new WorkspaceError(
      "git_command_failed",
      `git ${args.join(" ")} failed${detail}`,
      {
        cause: error,
      },
    );
  }
}

export async function getAbsoluteGitDir(
  cwd: string,
  options: GitProcessOptions = {},
): Promise<string> {
  const result = await runGit(["rev-parse", "--absolute-git-dir"], {
    cwd,
    ...options,
  });
  const gitDir = result.stdout.trim();
  if (!gitDir) {
    throw new WorkspaceError(
      "git_command_failed",
      `git rev-parse --absolute-git-dir returned no path for ${cwd}`,
    );
  }
  return path.resolve(gitDir);
}

export async function getGitCommonDir(
  cwd: string,
  options: GitProcessOptions & { signal?: AbortSignal } = {},
): Promise<string> {
  const result = await runGit(["rev-parse", "--git-common-dir"], {
    cwd,
    ...options,
  });
  const commonDir = result.stdout.trim();
  if (!commonDir) {
    throw new WorkspaceError(
      "git_command_failed",
      `git rev-parse --git-common-dir returned no path for ${cwd}`,
    );
  }
  return path.resolve(cwd, commonDir);
}

async function findWorkspaceGitOperationMarker(
  gitDir: string,
): Promise<WorkspaceGitOperationMarker | undefined> {
  for (const marker of WORKSPACE_GIT_OPERATION_MARKERS) {
    for (const markerName of marker.markerNames) {
      if (await pathExists(path.join(gitDir, markerName))) {
        return marker;
      }
    }
  }
  return undefined;
}

export type GitRepoKind = "work-tree" | "bare" | "none";

function fsErrorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

const BARE_GIT_REPOSITORY_REASON = "Path is a bare Git repository";

function isGitRepoFailureStderr(stderr: string): boolean {
  return /dubious ownership|unsafe repository|gitfile|not a git repository:/iu.test(
    stderr,
  );
}

// Git can refuse a bare repository (`safe.bareRepository=explicit`); its
// HEAD file and objects folder still mark it as Git storage, not a plain folder.
async function hasBareGitLayout(dir: string): Promise<boolean> {
  const [head, objects] = await Promise.all([
    fs.stat(path.join(dir, "HEAD")).catch(() => null),
    fs.stat(path.join(dir, "objects")).catch(() => null),
  ]);
  return head?.isFile() === true && objects?.isDirectory() === true;
}

async function describeNonGitPathReason(
  cwd: string,
  gitStderr: string,
): Promise<string> {
  let stats;
  try {
    stats = await fs.stat(cwd);
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return "Path does not exist";
    }
    return "Path is not accessible";
  }
  if (!stats.isDirectory()) {
    return "Path is not a directory";
  }
  try {
    await fs.access(cwd, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    return "Path is not accessible";
  }
  const startDir = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  let current = startDir;
  while (true) {
    try {
      await fs.lstat(path.join(current, ".git"));
      return "Git repository is unreadable or invalid";
    } catch (error) {
      const code = fsErrorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        if (current === startDir) {
          return "Path is not accessible";
        }
        break;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  if (isGitRepoFailureStderr(gitStderr)) {
    return "Git repository is unreadable or invalid";
  }
  if (await hasBareGitLayout(startDir)) {
    return BARE_GIT_REPOSITORY_REASON;
  }
  return PLAIN_NON_GIT_DIRECTORY_REASON;
}

async function probeGitRepoKind(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<{ kind: GitRepoKind; stderr: string }> {
  const result = await runGit(
    ["rev-parse", "--is-inside-work-tree", "--is-bare-repository"],
    { cwd, ...options, allowFailure: true },
  );
  if (result.exitCode !== 0) {
    return { kind: "none", stderr: result.stderr };
  }
  const [insideWorkTree, bare] = trimOutput(result.stdout).split("\n");
  if (insideWorkTree === "true") {
    return { kind: "work-tree", stderr: "" };
  }
  if (bare === "true") {
    return { kind: "bare", stderr: "" };
  }
  return { kind: "none", stderr: result.stderr };
}

export async function detectGitRepoKind(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<GitRepoKind> {
  return (await probeGitRepoKind(cwd, options)).kind;
}

export async function inspectGitRepoKind(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<{ kind: "work-tree" | "bare" } | { kind: "none"; reason: string }> {
  const probed = await probeGitRepoKind(cwd, options);
  if (probed.kind !== "none") {
    return { kind: probed.kind };
  }
  return {
    kind: "none",
    reason: await describeNonGitPathReason(cwd, probed.stderr),
  };
}

export async function detectGitRepo(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<boolean> {
  return (await detectGitRepoKind(cwd, options)) === "work-tree";
}

export async function detectLinkedWorktree(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<boolean> {
  const gitDirResult = await runGit(["rev-parse", "--git-dir"], {
    cwd,
    ...options,
    allowFailure: true,
  });
  if (gitDirResult.exitCode !== 0) {
    return false;
  }
  return gitDirResult.stdout.trim().includes("/worktrees/");
}

export async function detectGitSource(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<boolean> {
  return (await detectGitRepoKind(cwd, options)) !== "none";
}

export async function ensureGitRepo(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<void> {
  if (await detectGitSource(cwd, options)) {
    return;
  }

  throw new WorkspaceError(
    "not_git_repo",
    `Path is not a git repository: ${cwd}`,
  );
}

async function readHeadSha(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", "HEAD"], {
    cwd,
    ...options,
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    return null;
  }

  const sha = trimOutput(result.stdout);
  return sha || null;
}

export async function getCurrentBranch(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<string | undefined> {
  if (!(await detectGitRepo(cwd, options))) {
    return undefined;
  }

  const result = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd,
    ...options,
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    return undefined;
  }

  const branchName = trimOutput(result.stdout);
  return branchName || undefined;
}

export async function getCheckoutRef(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<GitCheckoutRef> {
  const repo = await inspectGitRepoKind(cwd, options);
  if (repo.kind === "none") {
    return { kind: "unknown", reason: repo.reason };
  }

  const [symbolicRef, headSha] = await Promise.all([
    runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd,
      ...options,
      allowFailure: true,
    }),
    readHeadSha(cwd, options),
  ]);

  const branchName = trimOutput(symbolicRef.stdout);
  if (symbolicRef.exitCode === 0 && branchName) {
    if (headSha === null) {
      // An empty bare repository has no work tree to run in (#2704).
      return repo.kind === "bare"
        ? { kind: "unknown", reason: BARE_GIT_REPOSITORY_REASON }
        : { kind: "unborn", branchName };
    }
    return { kind: "branch", branchName, headSha };
  }

  if (headSha !== null) {
    return { kind: "detached", headSha };
  }

  return {
    kind: "unknown",
    reason: "HEAD is not symbolic and no commit is checked out",
  };
}

function appendUtf8Bytes(bytes: number[], value: string): void {
  bytes.push(...Buffer.from(value, "utf8"));
}

function isOctalDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "7";
}

function readEscapedPorcelainPathBytes(
  bytes: number[],
  rawPath: string,
  startIndex: number,
): number {
  const escapeChar = rawPath[startIndex + 1];
  if (escapeChar === undefined) {
    return startIndex + 1;
  }
  if (isOctalDigit(escapeChar)) {
    let octalValue = escapeChar;
    let index = startIndex + 2;
    while (octalValue.length < 3 && isOctalDigit(rawPath[index])) {
      octalValue += rawPath[index] ?? "";
      index += 1;
    }
    bytes.push(Number.parseInt(octalValue, 8));
    return index;
  }
  const escapedByte = GIT_QUOTED_PATH_ESCAPE_BYTES.get(escapeChar);
  if (escapedByte !== undefined) {
    bytes.push(escapedByte);
  } else {
    appendUtf8Bytes(bytes, escapeChar);
  }
  return startIndex + 2;
}

function parseQuotedPorcelainPathToken(
  rawPath: string,
  startIndex: number,
): ParsedPorcelainPathToken {
  const bytes: number[] = [];
  let index = startIndex + 1;
  while (index < rawPath.length) {
    const currentChar = rawPath[index];
    if (currentChar === '"') {
      return {
        nextIndex: index + 1,
        value: Buffer.from(bytes).toString("utf8"),
      };
    }
    if (currentChar === "\\") {
      index = readEscapedPorcelainPathBytes(bytes, rawPath, index);
      continue;
    }
    const codePoint = rawPath.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const character = String.fromCodePoint(codePoint);
    appendUtf8Bytes(bytes, character);
    index += character.length;
  }
  return {
    nextIndex: rawPath.length,
    value: rawPath.slice(startIndex),
  };
}

function parseUnquotedPorcelainPathToken(
  rawPath: string,
  startIndex: number,
): ParsedPorcelainPathToken {
  const separatorIndex = rawPath.indexOf(" -> ", startIndex);
  const endIndex = separatorIndex === -1 ? rawPath.length : separatorIndex;
  return {
    nextIndex: endIndex,
    value: rawPath.slice(startIndex, endIndex),
  };
}

function parsePorcelainPathToken(
  rawPath: string,
  startIndex: number,
): ParsedPorcelainPathToken {
  if (rawPath[startIndex] === '"') {
    return parseQuotedPorcelainPathToken(rawPath, startIndex);
  }
  return parseUnquotedPorcelainPathToken(rawPath, startIndex);
}

function parsePorcelainPath(rawPath: string): string {
  const sourcePath = parsePorcelainPathToken(rawPath, 0);
  if (
    rawPath.slice(sourcePath.nextIndex, sourcePath.nextIndex + 4) !== " -> "
  ) {
    return sourcePath.value;
  }
  return parsePorcelainPathToken(rawPath, sourcePath.nextIndex + 4).value;
}

export function parsePorcelainEntries(statusOutput: string): PorcelainEntry[] {
  return statusOutput
    .split("\n")
    .filter((line) => line && !line.startsWith("##"))
    .map((line) => {
      const indexStatus = line[0] ?? " ";
      const worktreeStatus = line[1] ?? " ";
      const status = line.slice(0, 2).trim() || line.slice(0, 2);
      const rawPath = line.slice(3).trim();

      return {
        path: parsePorcelainPath(rawPath),
        status,
        indexStatus,
        worktreeStatus,
      };
    });
}

function hasPorcelainConflict(entries: PorcelainEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.indexStatus === "U" ||
      entry.worktreeStatus === "U" ||
      CONFLICT_PORCELAIN_STATUSES.has(entry.status),
  );
}

function buildActiveWorkspaceGitOperation(
  kind: ActiveWorkspaceGitOperationKind,
  hasConflicts: boolean,
): WorkspaceGitOperation {
  switch (kind) {
    case "merge":
      return { kind: "merge", hasConflicts };
    case "rebase":
      return { kind: "rebase", hasConflicts };
    case "cherry-pick":
      return { kind: "cherry-pick", hasConflicts };
    case "revert":
      return { kind: "revert", hasConflicts };
  }
}

export async function getWorkspaceGitOperation(
  cwd: string,
  options: GitProcessOptions = {},
): Promise<WorkspaceGitOperation> {
  return (await readWorkspaceGitState(cwd, options)).operation;
}

export async function readWorkspaceGitState(
  cwd: string,
  options: GitProcessOptions = {},
): Promise<{
  hasUncommittedChanges: boolean;
  operation: WorkspaceGitOperation;
}> {
  await ensureGitRepo(cwd, options);

  const [gitDir, status] = await Promise.all([
    getAbsoluteGitDir(cwd, options),
    runGit(
      [
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "--untracked-files=no",
      ],
      { cwd, ...options },
    ),
  ]);
  const hasConflicts = hasPorcelainConflict(
    parsePorcelainEntries(status.stdout),
  );
  const marker = await findWorkspaceGitOperationMarker(gitDir);
  return {
    hasUncommittedChanges: status.stdout.trim().length > 0,
    operation: marker
      ? buildActiveWorkspaceGitOperation(marker.kind, hasConflicts)
      : { kind: "none" },
  };
}

const {
  readDefaultBranch,
  readDefaultBranchRefs,
  readLocalBranches,
  readOriginHeadBranchName,
  hasRef,
} = createGitBranchQueries({ runGit, ensureGitRepo });

export { readDefaultBranch, readDefaultBranchRefs, hasRef };

async function fetchRemoteBranchesNonInteractively(
  cwd: string,
  options: GitTimeoutOptions,
): Promise<FetchRemoteBranchesResult> {
  const args = [...gitSafetyArgs(), "fetch", "--all", "--prune", "--quiet"];
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      detached: supportsProcessGroups(),
      windowsHide: true,
      stdio: "ignore",
      env: resolveGitProcessEnv({
        shellPath: options.shellPath,
        env: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "false",
          SSH_ASKPASS: "false",
          SSH_ASKPASS_REQUIRE: "never",
          GCM_INTERACTIVE: "never",
        },
      }),
    });
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            killProcessGroup({ child, signal: "SIGKILL" });
          }, options.timeoutMs);
    child.once("error", () => {
      clearTimeout(timeout);
      resolve({ status: "failed" });
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ status: code === 0 ? "fetched" : "failed" });
    });
  });
}

export async function fetchRemoteBranches(
  cwd: string,
  { interactive, ...options }: FetchRemoteBranchesOptions,
): Promise<FetchRemoteBranchesResult> {
  await ensureGitRepo(cwd, options);

  const remotes = await runGit(["remote"], {
    cwd,
    ...options,
    allowFailure: true,
  });
  if (
    remotes.exitCode !== 0 ||
    remotes.stdout
      .split("\n")
      .map((remote) => remote.trim())
      .filter(Boolean).length === 0
  ) {
    return { status: "skipped" };
  }

  if (!interactive) {
    return fetchRemoteBranchesNonInteractively(cwd, options);
  }

  try {
    const result = await runGit(["fetch", "--all", "--prune", "--quiet"], {
      cwd,
      ...options,
      allowFailure: true,
    });
    return { status: result.exitCode === 0 ? "fetched" : "failed" };
  } catch (error) {
    if (
      error instanceof WorkspaceError &&
      error.code === "git_command_timeout"
    ) {
      return { status: "failed" };
    }
    throw error;
  }
}

/** Agents push straight to GitHub, so a local branch like `main` lags behind; compare against `origin/<branch>` when it
 *  exists. Returns a full ref, so tags can't shadow it and resolving it again changes nothing. */

interface ReadGitBlobResult {
  contents: Buffer | null;
  sizeBytes: number;
}

async function gitBlobSize(
  cwd: string,
  ref: string,
  relativePath: string,
  options: GitProcessOptions,
): Promise<number | undefined> {
  await ensureGitRepo(cwd, options);
  const target = `${ref}:${relativePath}`;
  const typeArgs = ["cat-file", "-t", target];
  const typeResult = await runGit(typeArgs, {
    cwd,
    ...options,
    allowFailure: true,
  });
  if (typeResult.exitCode !== 0) {
    const stderr = trimOutput(typeResult.stderr);
    if (isMissingGitBlobTargetError(stderr)) {
      return undefined;
    }
    throw createGitCommandFailedError(typeArgs, stderr);
  }

  const objectType = trimOutput(typeResult.stdout);
  if (objectType !== "blob") {
    throw new WorkspaceError(
      "git_command_failed",
      `git cat-file -t ${target} returned ${objectType || "unknown object type"}, expected blob`,
    );
  }

  const sizeArgs = ["cat-file", "-s", target];
  const sizeResult = await runGit(sizeArgs, {
    cwd,
    ...options,
    allowFailure: true,
  });
  if (sizeResult.exitCode !== 0) {
    const stderr = trimOutput(sizeResult.stderr);
    if (isMissingGitBlobTargetError(stderr)) {
      return undefined;
    }
    throw createGitCommandFailedError(sizeArgs, stderr);
  }

  const parsed = Number.parseInt(trimOutput(sizeResult.stdout), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new WorkspaceError(
      "git_command_failed",
      `git cat-file -s ${target} returned invalid size ${trimOutput(
        sizeResult.stdout,
      )}`,
    );
  }
  return parsed;
}

export async function readGitBlob(
  cwd: string,
  ref: string,
  relativePath: string,
  maxBytes: number,
  options: GitProcessOptions = {},
): Promise<ReadGitBlobResult> {
  const target = `${ref}:${relativePath}`;
  const size = await gitBlobSize(cwd, ref, relativePath, options);
  if (size === undefined) {
    return { contents: null, sizeBytes: 0 };
  }
  if (size > maxBytes) {
    throw new WorkspaceError(
      "blob_too_large",
      `Blob size ${size} bytes exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`,
    );
  }

  const args = [...gitSafetyArgs(), "cat-file", "blob", target];
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      encoding: "buffer",
      env: resolveGitProcessEnv({
        env: undefined,
        shellPath: options.shellPath,
      }),
      maxBuffer: maxBytes,
    });
    const contents = Buffer.from(result.stdout);
    return { contents, sizeBytes: size };
  } catch (error) {
    if (isMaxBufferExceededError(error)) {
      throw new WorkspaceError(
        "blob_too_large",
        `Blob size exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`,
        { cause: error },
      );
    }

    const execError = toExecError(error);
    const stderr = trimOutput(execError?.stderr?.toString() ?? "");
    throw createGitCommandFailedError(
      ["cat-file", "blob", target],
      stderr,
      error,
    );
  }
}

export async function listBranches(
  cwd: string,
  options: GitProcessOptions = {},
): Promise<string[]> {
  await ensureGitRepo(cwd, options);
  return readLocalBranches(cwd, options);
}

export async function listRemoteBranches(
  cwd: string,
  options: GitProcessOptions = {},
): Promise<string[]> {
  await ensureGitRepo(cwd, options);
  const result = await runGit(
    ["for-each-ref", "--format=%(refname:short)%09%(symref)", "refs/remotes"],
    { cwd, ...options },
  );
  return result.stdout
    .split("\n")
    .map((line) => {
      const [branch = "", symref = ""] = line.split("\t");
      return { branch: branch.trim(), symref: symref.trim() };
    })
    .filter((ref) => ref.branch.length > 0 && ref.symref.length === 0)
    .map((ref) => ref.branch);
}

export async function listBranchRefsWithDefaults(
  cwd: string,
  options: GitProcessOptions = {},
): Promise<BranchRefsWithDefaults> {
  const [branches, remoteBranches, originHeadBranch] = await Promise.all([
    listBranches(cwd, options),
    listRemoteBranches(cwd, options),
    readOriginHeadBranchName(cwd, options),
  ]);
  const defaultBranch = resolvePreferredLocalDefaultBranch(
    branches,
    originHeadBranch,
  );
  const originDefaultBranch = [
    originHeadBranch ? `origin/${originHeadBranch}` : undefined,
    defaultBranch ? `origin/${defaultBranch}` : undefined,
  ].find(
    (branch): branch is string =>
      branch !== undefined && remoteBranches.includes(branch),
  );

  return {
    branches,
    defaultBranch,
    originDefaultBranch,
    remoteBranches,
  };
}

export async function hasUncommittedChanges(
  cwd: string,
  options: GitProcessOptions = {},
): Promise<boolean> {
  await ensureGitRepo(cwd, options);
  const status = await runGit(
    [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ],
    { cwd, ...options },
  );
  return status.stdout.trim().length > 0;
}
