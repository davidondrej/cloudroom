import { isUtf8 } from "node:buffer";
import type { Context } from "hono";
import mimeTypes from "mime-types";
import { z } from "zod";
import { rawDiffFileStatSchema, workspaceStatusSchema, type RawDiffFileStat, type WorkspaceDiffTarget, type WorkspaceStatus } from "@cloudroom/domain";
import { diffPatchEntrySchema, environmentDiffBranchesQuerySchema, environmentDiffBranchesResponseSchema, environmentDiffFileQuerySchema, environmentDiffPatchRequestSchema, environmentDiffQuerySchema, environmentStatusQuerySchema, type DiffFileEntry, type DiffPatchEntry, type EnvironmentDiffBranchesResponse, type EnvironmentDiffFileQuery, type EnvironmentDiffFileResponse, type EnvironmentDiffFilesResponse } from "@cloudroom/server-contract";
import { coreGitTarget } from "@cloudroom/host-workspace";
import { DIFF_FILE_PATCH_MAX_BYTES, WORKSPACE_DIFF_MAX_FILES, WORKSPACE_STATUS_MAX_UNTRACKED_LINE_STAT_BYTES, WORKSPACE_STATUS_MAX_UNTRACKED_LINE_STAT_FILES } from "../../constants.js";
import { rawDiffFileStatToEntry, selectInitialPatchPaths } from "../../routes/diff-tiering.js";
import { toWorkspaceDiffTarget } from "../../routes/environments.js";
import { normalizeBranchQuery, parseBranchListLimit } from "../../routes/branch-list-query.js";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import * as legacy from "./git-legacy.js";
import { SandboxAsleep } from "./sandboxes.js";
import { baseBranch, binding, command, lastGitStatus, saveBinding } from "./store.js";

/** Runs a bash script in the Cloud thread's checkout and returns stdout; throws CloudGitError on failure. */
export type CloudGitRun = (script: string, stdin?: Buffer) => Promise<Buffer>;

export class CloudGitError extends Error {
  constructor(message: string, readonly exitCode: number | null) { super(message); }
}

const SNAPSHOTS = 5;

/** Core's binary in every sandbox. */
const CORE = "/usr/local/lib/cloudroom/cloudroom";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const nul = (paths: readonly string[]) => Buffer.from(paths.map((path) => `${path}\0`).join(""));

/** Runs whose sandbox's Core predates `cloudroom git`: their reads go straight to the bash version. */
const oldCore = new WeakSet<CloudGitRun>();
/** Per thread, until when to assume that without asking the sandbox again. */
const oldCoreThreads = new Map<string, number>();
const OLD_CORE_RECHECK_MS = 10 * 60_000;

/** Runs Core's `cloudroom git` (core/src/git.rs) in the checkout. `null` when the sandbox's Core predates it. */
async function core(run: CloudGitRun, args: (string | number)[], stdin?: Buffer): Promise<Buffer | null> {
  if (oldCore.has(run)) return null;
  try {
    return await run(`ulimit -t 60 2>/dev/null; exec ${CORE} git ${args.map((arg) => quote(String(arg))).join(" ")}`, stdin);
  } catch (error) {
    // An older Core exits 2 with "Unknown command git."; a new one's usage errors also exit 2, and stay errors.
    if (!(error instanceof CloudGitError && error.exitCode === 2 && error.message.includes("Unknown command git"))) throw error;
    oldCore.add(run);
    return null;
  }
}

const json = (output: Buffer) => JSON.parse(output.toString("utf8")) as unknown;
const filesSchema = z.object({ files: z.array(rawDiffFileStatSchema), shortstat: z.string(), mergeBaseRef: z.string().nullable(), truncated: z.boolean() });

/** Without `mergeBaseBranch`, compares with the default branch: the app learns a thread's base this way. */
export async function cloudGitStatus(run: CloudGitRun, mergeBaseBranch?: string): Promise<WorkspaceStatus> {
  const output = await core(run, ["status", "--untracked-files", WORKSPACE_STATUS_MAX_UNTRACKED_LINE_STAT_FILES, "--untracked-bytes", WORKSPACE_STATUS_MAX_UNTRACKED_LINE_STAT_BYTES, ...(mergeBaseBranch ? ["--base", mergeBaseBranch] : ["--default-base"])]);
  return output ? workspaceStatusSchema.parse(json(output)) : legacy.cloudGitStatus(run, mergeBaseBranch);
}

export async function cloudGitDiffFiles(run: CloudGitRun, target: WorkspaceDiffTarget): Promise<Extract<EnvironmentDiffFilesResponse, { outcome: "available" }>> {
  const output = await core(run, ["files", coreGitTarget(target), "--max-files", WORKSPACE_DIFF_MAX_FILES]);
  if (!output) return legacy.cloudGitDiffFiles(run, target);
  const result = filesSchema.parse(json(output));
  const files = result.files.map(rawDiffFileStatToEntry);
  const initialPaths = selectInitialPatchPaths(files);
  return {
    outcome: "available",
    ...result,
    files,
    initialPatches: initialPaths.length > 0 ? await cloudGitDiffPatch(run, target, initialPaths).catch(() => []) : [],
  };
}

/** `known` pairs a renamed file with its old path, for the bash version; Core finds renames itself. */
export async function cloudGitDiffPatch(run: CloudGitRun, target: WorkspaceDiffTarget, paths: readonly string[], known: readonly Pick<RawDiffFileStat, "path" | "previousPath">[] = []): Promise<DiffPatchEntry[]> {
  if (paths.length === 0) return [];
  const output = await core(run, ["patch", coreGitTarget(target), "--max-bytes", DIFF_FILE_PATCH_MAX_BYTES], nul(paths));
  return output ? z.array(diffPatchEntrySchema).parse(json(output)) : legacy.cloudGitDiffPatch(run, target, paths, known);
}

export async function cloudGitFile(run: CloudGitRun, query: EnvironmentDiffFileQuery): Promise<EnvironmentDiffFileResponse> {
  const path = query.path.replace(/^\/+/u, "");
  if (path.split("/").some((segment) => segment === ".." || segment === "")) throw new ApiError(400, "invalid_request", "Invalid path");
  const target = query.target === "commit" ? `commit:${query.sha}` : query.target === "branch_committed" ? "branch" : query.target;
  const content = await core(run, ["show", target, query.side, ...(query.target === "branch_committed" || query.target === "all" ? ["--merge-base", query.mergeBaseRef] : []), "--", path]);
  if (!content) return legacy.cloudGitFile(run, query);
  const mimeType = mimeTypes.lookup(path) || undefined;
  const image = mimeType?.startsWith("image/") === true && mimeType !== "image/svg+xml";
  const utf8 = !image && isUtf8(content);
  return { path, content: content.toString(utf8 ? "utf8" : "base64"), contentEncoding: utf8 ? "utf8" : "base64", ...(mimeType ? { mimeType } : {}), sizeBytes: content.length };
}

export async function cloudGitBranches(run: CloudGitRun, query: string | undefined, limit: number, selectedBranch?: string): Promise<EnvironmentDiffBranchesResponse> {
  const output = await core(run, ["branches", "--limit", limit, ...(query ? ["--query", query] : []), ...(selectedBranch ? ["--selected", selectedBranch] : [])]);
  return output ? environmentDiffBranchesResponseSchema.parse(json(output)) : legacy.cloudGitBranches(run, query, limit, selectedBranch);
}

const NOT_A_REPO = 3;
const ASLEEP = "The cloud sandbox is asleep. Git details show here once it wakes.";
const RECENT_BYTES = 32 * 1024 * 1024;
const RECENT_ITEM_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_BYTES = 256 * 1024;
const recent = new Map<string, { value: unknown; bytes: number }>();
let recentBytes = 0;
const snapshotsSchema = z.record(z.string(), workspaceStatusSchema);

/** Keeps recent answers for a sleeping sandbox, within a byte budget; big answers are not kept. */
function remember(key: string, value: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  recentBytes -= recent.get(key)?.bytes ?? 0;
  recent.delete(key);
  if (bytes > RECENT_ITEM_BYTES) return;
  recent.set(key, { value, bytes });
  recentBytes += bytes;
  for (const [oldest, entry] of recent) {
    if (recentBytes <= RECENT_BYTES) break;
    recent.delete(oldest);
    recentBytes -= entry.bytes;
  }
}

function savedSnapshots(lastGitStatus: string | null | undefined): Record<string, WorkspaceStatus> {
  const parsed = snapshotsSchema.safeParse(lastGitStatus ? JSON.parse(lastGitStatus) as unknown : {});
  return parsed.success ? parsed.data : {};
}

/** Serves `/environments/cloudgit_<thread>/...`, the Git reads the diff and info panels make, from the Cloud thread's sandbox.
 *  Reads never wake it. While it sleeps, status comes from the snapshot saved for the same comparison branch, and diffs
 *  from this run's recent answers. */
export async function cloudGitResponse(deps: AppDeps, threadId: string, context: Context, run: CloudGitRun): Promise<unknown> {
  const saved = binding(deps.db, threadId);
  if (!saved) throw new ApiError(404, "not_found", "Environment not found");
  const workspacePath = savedWorkspacePath(saved.lastWorkspace) ?? "Cloud sandbox";
  const action = context.req.path.replace(/^.*\/environments\/[^/]+\//u, "");
  const body = context.req.method === "GET" ? null : await context.req.json() as unknown;
  const key = `${threadId} ${action} ${body === null ? new URL(context.req.url).search : JSON.stringify(body)}`;
  const snapshotKey = action === "status" ? environmentStatusQuerySchema.parse(context.req.query()).mergeBaseBranch ?? "" : "";
  const unavailable = (message: string) => ({ outcome: "unavailable", failure: { code: "unknown", workspacePath, message } });
  const assumeOldCore = (oldCoreThreads.get(threadId) ?? 0) > Date.now();
  if (assumeOldCore) oldCore.add(run);
  try {
    if (action === "status") {
      const workspace = await cloudGitStatus(run, snapshotKey || baseBranch(command(deps.db, `first_${threadId}`)?.input));
      const latest = lastGitStatus(deps.db, threadId);
      const others = Object.entries(savedSnapshots(latest)).filter(([branch]) => branch !== snapshotKey).slice(1 - SNAPSHOTS);
      // A huge status (thousands of changed files) is not saved, like remember() skips big answers.
      const next = JSON.stringify(Object.fromEntries([...others, [snapshotKey, workspace]]));
      if (next !== latest && Buffer.byteLength(JSON.stringify(workspace)) <= SNAPSHOT_BYTES) saveBinding(deps.db, threadId, { lastGitStatus: next });
      return { outcome: "available", workspace };
    }
    if (action === "pull-request") return { outcome: "absent" };
    if (action === "diff/branches") {
      const query = environmentDiffBranchesQuerySchema.parse(context.req.query());
      return await cloudGitBranches(run, normalizeBranchQuery(query.query), parseBranchListLimit(query.limit), normalizeBranchQuery(query.selectedBranch));
    }
    let value: unknown;
    if (action === "diff/files") {
      const target = toWorkspaceDiffTarget(environmentDiffQuerySchema.parse(context.req.query()));
      const files = await cloudGitDiffFiles(run, target);
      remember(`files ${threadId} ${JSON.stringify(target)}`, files.files);
      value = files;
    } else if (action === "diff/patch") {
      const request = environmentDiffPatchRequestSchema.parse(body);
      const known = recent.get(`files ${threadId} ${JSON.stringify(request.target)}`)?.value as DiffFileEntry[] | undefined;
      value = { outcome: "available", patches: await cloudGitDiffPatch(run, request.target, request.paths, known) };
    } else if (action === "diff/file") {
      value = await cloudGitFile(run, environmentDiffFileQuerySchema.parse(context.req.query()));
    } else {
      throw new ApiError(404, "not_found", "This is not available for Cloud threads yet.");
    }
    remember(key, value);
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof CloudGitError && error.exitCode === NOT_A_REPO) return { outcome: "not_applicable", reason: "non_git_environment", message: error.message };
    const message = error instanceof SandboxAsleep ? ASLEEP : error instanceof Error ? error.message : String(error);
    if (action === "status") {
      const cached = savedSnapshots(lastGitStatus(deps.db, threadId))[snapshotKey];
      return cached ? { outcome: "available", workspace: cached } : unavailable(message);
    }
    const cached = recent.get(key);
    if (cached) return cached.value;
    if (action === "diff/file") throw new ApiError(409, "cloud_git_unavailable", message);
    if (action === "diff/branches") return { branches: [], branchesTruncated: false, remoteBranches: [], remoteBranchesTruncated: false, selectedBranch: null };
    return unavailable(message);
  } finally {
    // What this read learned about the sandbox's Core, unless it went on what an earlier read learned.
    if (!assumeOldCore && oldCore.has(run)) oldCoreThreads.set(threadId, Date.now() + OLD_CORE_RECHECK_MS);
    if (!assumeOldCore && !oldCore.has(run)) oldCoreThreads.delete(threadId);
  }
}

export function savedWorkspacePath(lastWorkspace: string | null): string | null {
  if (!lastWorkspace) return null;
  const value = JSON.parse(lastWorkspace) as { path?: unknown } | null;
  return typeof value?.path === "string" && value.path ? value.path : null;
}
