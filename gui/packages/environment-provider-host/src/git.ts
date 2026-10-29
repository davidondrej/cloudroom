import {
  experimental_sanitizeInheritedChildProcessEnv as sanitizeInheritedChildProcessEnv,
  experimental_spawnPortableOutputProcess as spawnPortableOutputProcess,
} from "@get-bb/plugin-sdk/host";
import path from "node:path";
import { createGitBranchQueries } from "./git-branches.js";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

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

interface GitTimeoutOptions extends GitProcessOptions {
  timeoutMs?: number;
}

export interface RunGitOptions extends GitProcessOptions {
  cwd: string;
  timeoutMs?: number;
  allowFailure?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitRepositoryState = "not_git" | "no_commits" | "has_commits";

export type DefaultBranchRelation =
  | "equal"
  | "local-behind"
  | "local-ahead"
  | "diverged"
  | "unknown";

export interface DefaultBranchRefs {
  defaultBranch: string | undefined;
  defaultBranchRelation: DefaultBranchRelation | undefined;
  originDefaultBranch: string | undefined;
}

type GitRepoKind = "work-tree" | "bare" | "none";

interface GitOutputBuffer {
  append: (chunk: Buffer) => boolean;
  read: () => string;
}

function trimOutput(value: string): string {
  return value.trim().replace(/\n+$/u, "");
}

function describeCommand(args: string[]): string {
  return `git ${args.join(" ")}`;
}

function createGitCommandCancelledError(
  args: string[],
  cause?: unknown,
): WorkspaceError {
  return new WorkspaceError(
    "provision_cancelled",
    `${describeCommand(args)} was cancelled`,
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
    `${describeCommand(args)} failed${detail}`,
    { cause },
  );
}

function resolveGitProcessEnv(options: RunGitOptions): NodeJS.ProcessEnv {
  return {
    ...sanitizeInheritedChildProcessEnv({
      env: process.env,
      ...(options.shellPath !== undefined
        ? { shellPath: options.shellPath }
        : {}),
    }),
    ...options.env,
  };
}

function createGitOutputBuffer(): GitOutputBuffer {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    append(chunk: Buffer): boolean {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        return false;
      }
      chunks.push(chunk);
      return true;
    },
    read(): string {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

export function runGit(
  args: string[],
  options: RunGitOptions,
): Promise<GitCommandResult> {
  if (options.signal?.aborted) {
    return Promise.reject(
      createGitCommandCancelledError(args, options.signal.reason),
    );
  }

  return new Promise<GitCommandResult>((resolve, reject) => {
    const stdout = createGitOutputBuffer();
    const stderr = createGitOutputBuffer();
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const child = spawnPortableOutputProcess({
      command: "git",
      args,
      cwd: options.cwd,
      env: resolveGitProcessEnv(options),
    });

    const onAbort = (): void => {
      child.kill("SIGTERM");
    };

    const release = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      options.signal?.removeEventListener("abort", onAbort);
    };

    const fail = (error: WorkspaceError): void => {
      if (settled) {
        return;
      }
      settled = true;
      release();
      reject(error);
    };

    const succeed = (result: GitCommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      release();
      resolve(result);
    };

    const readInto = (buffer: GitOutputBuffer) => {
      return (chunk: Buffer): void => {
        if (!buffer.append(chunk)) {
          overflowed = true;
          child.kill("SIGKILL");
        }
      };
    };

    child.stdout.on("data", readInto(stdout));
    child.stderr.on("data", readInto(stderr));

    child.on("error", (error) => {
      if (options.signal?.aborted) {
        fail(createGitCommandCancelledError(args, error));
        return;
      }
      if (options.allowFailure === true) {
        succeed({ stdout: "", stderr: "", exitCode: 1 });
        return;
      }
      fail(createGitCommandFailedError(args, "", error));
    });

    child.on("close", (code) => {
      if (options.signal?.aborted) {
        fail(createGitCommandCancelledError(args, options.signal.reason));
        return;
      }
      if (timedOut) {
        fail(
          new WorkspaceError(
            "git_command_timeout",
            `${describeCommand(args)} timed out after ${options.timeoutMs}ms`,
          ),
        );
        return;
      }
      if (overflowed) {
        fail(
          new WorkspaceError(
            "git_command_failed",
            `${describeCommand(args)} produced more than ${MAX_OUTPUT_BYTES} bytes of output`,
          ),
        );
        return;
      }
      const result: GitCommandResult = {
        stdout: stdout.read(),
        stderr: stderr.read(),
        exitCode: code ?? 1,
      };
      if (result.exitCode === 0 || options.allowFailure === true) {
        succeed(result);
        return;
      }
      fail(createGitCommandFailedError(args, trimOutput(result.stderr)));
    });

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
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

async function detectGitRepoKind(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<GitRepoKind> {
  const result = await runGit(
    ["rev-parse", "--is-inside-work-tree", "--is-bare-repository"],
    { cwd, ...options, allowFailure: true },
  );
  if (result.exitCode !== 0) {
    return "none";
  }
  const [insideWorkTree, bare] = trimOutput(result.stdout).split("\n");
  if (insideWorkTree === "true") {
    return "work-tree";
  }
  if (bare === "true") {
    return "bare";
  }
  return "none";
}

export async function detectGitRepo(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<boolean> {
  return (await detectGitRepoKind(cwd, options)) === "work-tree";
}

async function detectGitSource(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<boolean> {
  return (await detectGitRepoKind(cwd, options)) !== "none";
}

async function ensureGitRepo(
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

export async function readGitRepositoryState(
  cwd: string,
  options: GitTimeoutOptions = {},
): Promise<GitRepositoryState> {
  if (!(await detectGitSource(cwd, options))) {
    return "not_git";
  }
  const result = await runGit(["rev-list", "--all", "--max-count=1"], {
    cwd,
    ...options,
  });
  return trimOutput(result.stdout).length > 0 ? "has_commits" : "no_commits";
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

export const { readDefaultBranch, readDefaultBranchRefs, hasRef } =
  createGitBranchQueries({ runGit, ensureGitRepo });

export async function findWorktreeForBranch(
  cwd: string,
  branchName: string,
  options: GitTimeoutOptions = {},
): Promise<string | null> {
  await ensureGitRepo(cwd, options);
  const result = await runGit(["worktree", "list", "--porcelain"], {
    cwd,
    ...options,
  });
  let worktreePath: string | null = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      worktreePath = line.slice("worktree ".length);
    } else if (
      line === `branch refs/heads/${branchName}` &&
      worktreePath !== null
    ) {
      return worktreePath;
    }
  }
  return null;
}
