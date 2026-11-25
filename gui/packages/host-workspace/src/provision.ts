import { stat } from "node:fs/promises";
import path from "node:path";
import type {
  ProvisioningTranscriptEntry,
  RawDiffFileStat,
  ThreadGitDiffResponse,
  WorkspaceDiffTarget,
  WorkspaceStatus,
} from "@cloudroom/domain";
import { pathExists } from "@cloudroom/process-utils";
import { GIT_NO_FETCH_ENV } from "bb-environment-provider-host/git";
import { withCheckoutMutationLock } from "./checkout-mutation-lock.js";
import { coreGit, coreGitTarget } from "./core-git.js";
import {
  getPullRequestForCurrentBranch,
  runPullRequestActionForCurrentBranch,
  type GitHostCliOptions,
  type GitHostPullRequestAction,
  type GitHostPullRequestLookup,
} from "./git-host.js";
import {
  detectGitRepo,
  detectLinkedWorktree,
  ensureGitRepo,
  getCurrentBranch,
  readDefaultBranch,
  runGit,
  WorkspaceError,
  type GitProcessOptions,
} from "./git.js";
import { resolveAdditionalWorkspaceWriteRoots } from "./workspace-write-roots.js";

type ProvisionProgressCallback = (entry: ProvisioningTranscriptEntry) => void;

export function throwIfProvisionAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new WorkspaceError("provision_cancelled", "Workspace provisioning was cancelled", { cause: signal.reason });
  }
}

export interface ProvisionWorkspaceArgs {
  path: string;
  onProgress?: ProvisionProgressCallback;
  shellPath?: string;
  signal?: AbortSignal;
}

export interface StatusOptions {
  mergeBaseBranch?: string;
  maxUntrackedLineStatFiles?: number;
  maxUntrackedLineStatBytes?: number;
}
export interface DiffOptions {
  target?: WorkspaceDiffTarget;
  maxDiffBytes?: number;
  maxFileListBytes?: number;
  maxUntrackedFiles?: number;
}
export interface DiffFilesArgs {
  target: WorkspaceDiffTarget;
  maxFiles: number;
}
export interface DiffFilesResult {
  files: RawDiffFileStat[];
  shortstat: string;
  mergeBaseRef: string | null;
  truncated: boolean;
}
export interface DiffPatchArgs {
  target: WorkspaceDiffTarget;
  paths: string[];
  maxBytesPerFile: number;
}
export interface DiffPatchEntry {
  path: string;
  patch: string;
  truncated: boolean;
}
export interface CommitOptions {
  message: string;
  noVerify: boolean;
}
export interface CommitResult {
  commitSha: string;
  commitSubject: string;
}
export type PullRequestActionOptions = GitHostPullRequestAction;

const WORKSPACE_GIT_TIMEOUT_MS = 15_000;
const COMMIT_TIMEOUT_MS = 5 * 60_000;

export interface HostWorkspace {
  readonly path: string;
  readonly isGitRepo: boolean;
  readonly isWorktree: boolean;

  getDefaultBranch(): Promise<string | null>;
  getCurrentBranch(): Promise<string | null>;
  getHeadSha(): Promise<string | null>;
  getLocalStateFingerprint(): Promise<string>;
  getSharedGitRefsFingerprint(): Promise<string>;
  getAdditionalWorkspaceWriteRoots(): Promise<string[]>;
  getStatus(options?: StatusOptions): Promise<WorkspaceStatus>;
  getDiff(options?: DiffOptions): Promise<ThreadGitDiffResponse>;
  diffFiles(args: DiffFilesArgs): Promise<DiffFilesResult>;
  diffPatch(args: DiffPatchArgs): Promise<DiffPatchEntry[]>;
  getPullRequest(options?: GitHostCliOptions): Promise<GitHostPullRequestLookup>;
  runPullRequestAction(action: PullRequestActionOptions, options?: GitHostCliOptions): Promise<void>;
  commit(options: CommitOptions): Promise<CommitResult>;
}

/** A checkout on this host. Status, diffs and commits come from Core's `cloudroom git`, the same code Cloud threads use. */
class ProvisionedHostWorkspace implements HostWorkspace {
  private readonly git: GitProcessOptions;

  constructor(
    readonly path: string,
    readonly isGitRepo: boolean,
    readonly isWorktree: boolean,
    shellPath?: string,
  ) {
    this.git = shellPath !== undefined ? { shellPath } : {};
  }

  private core<T>(args: (string | number)[], options: { stdin?: string; timeoutMs?: number } = {}): Promise<T> {
    return coreGit<T>(this.path, args, { ...this.git, ...options });
  }

  /** The watcher's automatic reads, so they never fetch (#2189). */
  private async lines(args: string[]): Promise<string> {
    return (await runGit(args, { cwd: this.path, timeoutMs: WORKSPACE_GIT_TIMEOUT_MS, env: GIT_NO_FETCH_ENV, ...this.git })).stdout;
  }

  async getCurrentBranch(): Promise<string | null> {
    return (await getCurrentBranch(this.path, this.git)) ?? null;
  }

  async getDefaultBranch(): Promise<string | null> {
    if (!this.isGitRepo) return null;
    return (await readDefaultBranch(this.path, { timeoutMs: WORKSPACE_GIT_TIMEOUT_MS, ...this.git })) ?? null;
  }

  async getHeadSha(): Promise<string | null> {
    await ensureGitRepo(this.path, this.git);
    const result = await runGit(["rev-parse", "-q", "--verify", "HEAD^{commit}"], { cwd: this.path, allowFailure: true, env: GIT_NO_FETCH_ENV, ...this.git });
    return result.exitCode === 0 ? result.stdout.trim() || null : null;
  }

  /** Changes when HEAD or the files on disk change. */
  async getLocalStateFingerprint(): Promise<string> {
    await ensureGitRepo(this.path, this.git);
    const [headSha, porcelain] = await Promise.all([
      this.getHeadSha(),
      // No rename detection: in a blobless clone it can need a missing old file.
      this.lines([
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "--branch",
        "--untracked-files=normal",
        "--no-renames",
      ]).catch(() => null),
    ]);
    if (porcelain !== null) return JSON.stringify({ headSha, porcelain });
    // Status fails when HEAD's tree is missing and may not be fetched, as in a treeless clone after
    // `git reset --soft` (#2189). The index file changes on every staging and needs no Git object.
    // File edits notify on their own.
    const indexPath = path.resolve(
      this.path,
      (await this.lines(["rev-parse", "--git-path", "index"])).trim(),
    );
    const index = await stat(indexPath).then(
      ({ ino, size, mtimeMs }) => [ino, size, mtimeMs],
      () => null,
    );
    return JSON.stringify({ headSha, index });
  }

  /** Changes when any branch or origin's HEAD moves. */
  async getSharedGitRefsFingerprint(): Promise<string> {
    await ensureGitRepo(this.path, this.git);
    const [refs, remoteHead] = await Promise.all([
      this.lines(["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/remotes"]),
      runGit(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd: this.path, allowFailure: true, ...this.git }),
    ]);
    return JSON.stringify({
      refs: refs.split("\n").map((line) => line.trim()).filter(Boolean),
      remoteHead: remoteHead.exitCode === 0 ? remoteHead.stdout.trim() : "",
    });
  }

  getAdditionalWorkspaceWriteRoots(): Promise<string[]> {
    if (!this.isGitRepo || !this.isWorktree) return Promise.resolve([]);
    return resolveAdditionalWorkspaceWriteRoots(this.path, this.git);
  }

  getStatus(options: StatusOptions = {}): Promise<WorkspaceStatus> {
    return this.core([
      "status",
      ...(options.mergeBaseBranch ? ["--base", options.mergeBaseBranch] : []),
      ...(options.maxUntrackedLineStatFiles ? ["--untracked-files", options.maxUntrackedLineStatFiles] : []),
      ...(options.maxUntrackedLineStatBytes ? ["--untracked-bytes", options.maxUntrackedLineStatBytes] : []),
    ]);
  }

  getDiff(options: DiffOptions = {}): Promise<ThreadGitDiffResponse> {
    return this.core([
      "diff",
      coreGitTarget(options.target ?? { type: "uncommitted" }),
      ...(options.maxDiffBytes ? ["--max-bytes", options.maxDiffBytes] : []),
      ...(options.maxFileListBytes ? ["--max-list-bytes", options.maxFileListBytes] : []),
      ...(options.maxUntrackedFiles ? ["--max-untracked", options.maxUntrackedFiles] : []),
    ]);
  }

  diffFiles(args: DiffFilesArgs): Promise<DiffFilesResult> {
    return this.core(["files", coreGitTarget(args.target), "--max-files", args.maxFiles]);
  }

  diffPatch(args: DiffPatchArgs): Promise<DiffPatchEntry[]> {
    return this.core(
      ["patch", coreGitTarget(args.target), "--max-bytes", args.maxBytesPerFile],
      { stdin: args.paths.map((path) => `${path}\0`).join("") },
    );
  }

  async getPullRequest(options: GitHostCliOptions = {}): Promise<GitHostPullRequestLookup> {
    if (!(await pathExists(this.path))) {
      return { outcome: "unavailable", message: `Workspace path no longer exists: ${this.path}` };
    }
    const localBranch = await getCurrentBranch(this.path, this.git);
    if (!localBranch) return { outcome: "none" };
    return getPullRequestForCurrentBranch({ cwd: this.path, localBranch, ...this.git, ...options });
  }

  async runPullRequestAction(action: PullRequestActionOptions, options: GitHostCliOptions = {}): Promise<void> {
    const localBranch = await getCurrentBranch(this.path, this.git);
    if (!localBranch) {
      throw new WorkspaceError("invalid_request", "Cannot update pull request from a detached workspace");
    }
    return runPullRequestActionForCurrentBranch({ cwd: this.path, localBranch, action, ...this.git, ...options });
  }

  commit(options: CommitOptions): Promise<CommitResult> {
    return withCheckoutMutationLock(
      this.path,
      // Hooks can be slow, but a commit stuck on a hidden prompt must not hold the checkout's lock forever.
      () => this.core(["commit", "--message", options.message, ...(options.noVerify ? ["--no-verify"] : [])], { timeoutMs: COMMIT_TIMEOUT_MS }),
      undefined,
      this.git,
    );
  }
}

export async function provisionWorkspace(opts: ProvisionWorkspaceArgs): Promise<HostWorkspace> {
  throwIfProvisionAborted(opts.signal);
  if (!(await pathExists(opts.path))) {
    throw new WorkspaceError("path_not_found", `Unmanaged workspace path does not exist: ${opts.path}`);
  }
  const git = opts.shellPath !== undefined ? { shellPath: opts.shellPath } : {};
  const isGitRepo = await detectGitRepo(opts.path, git);
  const isWorktree = isGitRepo ? await detectLinkedWorktree(opts.path, git) : false;
  return new ProvisionedHostWorkspace(opts.path, isGitRepo, isWorktree, opts.shellPath);
}
