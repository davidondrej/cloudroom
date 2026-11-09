import { execFile } from "node:child_process";
import { cp, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  createEventId,
  getEnvironment,
  getThread,
  updateThread,
  type EnvironmentRow,
} from "@cloudroom/db";
import { PERSONAL_PROJECT_ID, threadScope, type Thread } from "@cloudroom/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { prepareLocalForkWorktree } from "../cloudroom/fork.js";
import {
  cancelProviderEnvironmentCreation,
  markProviderEnvironmentAttached,
} from "../environments/environment-engine.js";
import { ENVIRONMENT_HOOK_TIMEOUT_MS } from "../environments/environment-hooks.js";
import { DEFAULT_ENVIRONMENT_PROVIDER_ID } from "../environments/environment-provider-ids.js";
import { runLiveHostCommand } from "../hosts/live-command.js";
import { resolvePrimaryHostId } from "../hosts/primary-host.js";
import { getEnvironmentProvider } from "../plugins/plugin-environment-provider-registry.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import { withThreadContextClearGuard } from "./thread-context-mutation-guard.js";
import { buildEnvironmentProvisionCommand } from "./thread-create-helpers.js";
import {
  prepareProviderEnvironment,
  resolveNewWorktreeOperationContext,
  worktreeProviderInputs,
} from "./thread-environment-placement.js";
import { appendThreadEvent } from "./thread-events.js";
import { stopThreadForCurrentState } from "./thread-lifecycle.js";

// `room-cli thread worktree` moves a Local thread into a new Cloudroom-managed worktree. It keeps its ID and chat,
// like a project move. The worktree starts from the thread's current commit when its turn ends. Other agents may
// share the old checkout, so only the uncommitted files the agent names come along (David, 2026-11-07).

const exec = promisify(execFile);
const OPERATION = "thread_worktree_move";
const SETUP_TIMEOUT_MS = 20 * 60_000;
const BUSY = "This thread is moving to a new worktree. Try again in a moment.";
/** Agents checked to resume in the new folder. Pi resumes in its session's saved folder and would keep editing the old one. */
const MOVABLE_PROVIDERS = new Set(["claude-code", "codex"]);

/** Threads waiting for their turn to end, with the paths they carry, relative to their folder. */
const pending = new Map<string, string[]>();
const moving = new Set<string>();

export function requestThreadWorktreeMove(
  deps: AppDeps,
  threadId: string,
  carry: readonly string[],
): { previousPath: string } {
  const { thread, folder } = movable(deps, threadId);
  for (const path of carry) carriedPath(folder.path, path);
  if (pending.has(thread.id) || moving.has(thread.id))
    throw new ApiError(409, "thread_busy", "This thread is already moving to a new worktree.");
  pending.set(thread.id, [...carry]);
  if (settled(deps, thread)) void applyPendingThreadWorktreeMove(deps, thread.id);
  return { previousPath: folder.path };
}

/** Runs from the thread-ready hook, before queued messages, so they start in the new worktree. */
export async function applyPendingThreadWorktreeMove(deps: AppDeps, threadId: string): Promise<void> {
  const carry = pending.get(threadId);
  const thread = getThread(deps.db, threadId);
  if (carry === undefined || !thread || !settled(deps, thread)) return;
  pending.delete(threadId);
  moving.add(threadId);
  const operationId = createEventId();
  const note = (status: "started" | "completed" | "failed", message: string, environmentId = thread.environmentId) =>
    appendThreadEvent(deps, {
      threadId,
      environmentId,
      type: "system/operation",
      scope: threadScope(),
      data: { operation: OPERATION, operationId, status, message },
    });
  note("started", "Moving this thread to a new worktree");
  try {
    // Sends wait until the move ends, so no turn starts in the old folder; queued messages stay queued.
    const { from, to } = await withThreadContextClearGuard(threadId, () => moveToNewWorktree(deps, threadId, carry), BUSY);
    note("completed", `Moved from ${from} to a new worktree at ${to}.`, getThread(deps.db, threadId)?.environmentId ?? null);
  } catch (error) {
    // Removes the new worktree if the thread never switched to it.
    await cancelProviderEnvironmentCreation(deps, threadId).catch((cleanup: unknown) =>
      deps.logger.warn({ threadId, error: cleanup }, "New worktree cleanup failed"));
    note("failed", `Could not move to a new worktree: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    moving.delete(threadId);
    requestQueuedMessageDispatch(deps, { kind: "thread-ready", threadId });
  }
}

/** A turn that ends in an error never fires the thread-ready hook, so its pending move starts here. */
export function watchFailedTurnsForWorktreeMoves(deps: AppDeps): void {
  deps.hub.onThreadChanged((threadId, changes) => {
    if (changes.includes("status-changed") && pending.has(threadId) && getThread(deps.db, threadId)?.status === "error")
      setImmediate(() => void applyPendingThreadWorktreeMove(deps, threadId));
  });
}

async function moveToNewWorktree(deps: AppDeps, threadId: string, carry: readonly string[]): Promise<{ from: string; to: string }> {
  const { thread, folder } = movable(deps, threadId);
  const record = getEnvironmentProvider(DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree);
  if (!record) throw new ApiError(409, "worktree_plugin_off", "Turn on the Worktree plugin in Settings → Plugins.");
  const head = await exec("git", ["-C", folder.path, "rev-parse", "HEAD"]).then(
    ({ stdout }) => stdout.trim(),
    () => { throw new ApiError(409, "not_a_git_checkout", `${folder.path} is not a Git checkout with commits.`); },
  );
  const files = await carriedFiles(folder.path, carry);
  // The fork's rule picks the source repo, so a thread in a nested repo gets a worktree of that repo (#971).
  const requested = {
    type: "provider" as const,
    environmentProviderId: DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree,
    machine: { type: "existing" as const, hostId: folder.hostId },
    inputs: worktreeProviderInputs({ kind: "named", name: head }),
  };
  const { environment } = await prepareLocalForkWorktree(deps, thread, thread.projectId, requested, "cli");
  const inputs = environment.type === "provider" ? environment.inputs ?? requested.inputs : requested.inputs;
  const context = await resolveNewWorktreeOperationContext(deps, thread, folder.hostId, inputs, record);
  const created = await createWorktree(deps, record, context);
  // Carried files land before setup, so `.bb-env-setup.sh` sees them, like `.worktreeinclude` files.
  await carryFiles(folder.path, created.path!, files);
  if (created.status !== "ready")
    await runLiveHostCommand(deps, {
      hostId: folder.hostId,
      command: buildEnvironmentProvisionCommand({
        environmentId: created.id,
        hostId: folder.hostId,
        initiator: null,
        path: created.path!,
        setupScriptTimeoutMs: ENVIRONMENT_HOOK_TIMEOUT_MS,
      }),
      timeoutMs: SETUP_TIMEOUT_MS,
    });
  const ready = getEnvironment(deps.db, created.id);
  if (ready?.status !== "ready" || !ready.path) throw new Error(ready?.statusMessage ?? "The worktree setup did not finish.");
  const current = getThread(deps.db, threadId);
  if (!current || !settled(deps, current))
    throw new ApiError(409, "thread_busy", "A new turn started before the worktree was ready. Run `room-cli thread worktree` again.");
  // The agent restarts in the new folder on its next turn.
  await stopThreadForCurrentState(deps, current, folder);
  deps.db.transaction((tx) => {
    updateThread(tx, deps.hub, threadId, { environmentId: ready.id });
    markProviderEnvironmentAttached(tx, threadId, ready.id);
  });
  return { from: folder.path, to: ready.path };
}

/** Drives the worktree provider until the folder exists, the same way a new thread's first start does. */
async function createWorktree(
  deps: AppDeps,
  record: NonNullable<ReturnType<typeof getEnvironmentProvider>>,
  context: Awaited<ReturnType<typeof resolveNewWorktreeOperationContext>>,
): Promise<EnvironmentRow> {
  const deadline = Date.now() + SETUP_TIMEOUT_MS;
  for (;;) {
    const decision = prepareProviderEnvironment(deps, record, context);
    if (decision.action === "reject") throw new ApiError(409, "worktree_failed", decision.message);
    if (decision.action === "ready") return decision.environment;
    if (Date.now() > deadline) throw new Error("The worktree took too long to create.");
    await delay(Math.min(1000, Math.max(250, decision.sendAt - Date.now())));
  }
}

function movable(deps: AppDeps, threadId: string): { thread: Thread; folder: EnvironmentRow & { path: string } } {
  const thread = getThread(deps.db, threadId);
  if (!thread || thread.deletedAt !== null) throw new ApiError(404, "thread_not_found", "Thread not found");
  if (thread.archivedAt !== null) throw new ApiError(409, "thread_not_writable", "Unarchive the thread, then move it.");
  if (thread.executionTarget === "cloud")
    throw new ApiError(409, "cloud_thread", "Cloud threads already run in their own sandbox.");
  if (thread.projectId === PERSONAL_PROJECT_ID)
    throw new ApiError(409, "personal_thread", "Only project threads can move into a worktree.");
  if (!MOVABLE_PROVIDERS.has(thread.providerId))
    throw new ApiError(409, "provider_cannot_move", "Only Claude Code and Codex threads can move into a worktree. Fork instead: `room-cli thread fork --new-environment worktree`.");
  const folder = thread.environmentId ? getEnvironment(deps.db, thread.environmentId) : null;
  if (!folder?.path) throw new ApiError(409, "no_folder", "This thread has no folder yet.");
  if (folder.hostId !== resolvePrimaryHostId(deps))
    throw new ApiError(409, "other_machine", "This thread runs on another computer.");
  if (folder.environmentProviderId === DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree)
    throw new ApiError(409, "already_worktree", "This thread already has its own worktree.");
  return { thread, folder: { ...folder, path: folder.path } };
}

function settled(deps: AppDeps, thread: Thread): boolean {
  return (thread.status === "idle" || thread.status === "error") &&
    !deps.pendingInteractions.hasPendingThreadInteraction(thread.id);
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** A carried path must stay inside the folder. */
function carriedPath(root: string, path: string): string {
  const full = resolve(root, path);
  if (isAbsolute(path) || full === resolve(root) || !inside(root, full))
    throw new ApiError(400, "invalid_request", `Carry paths must be inside ${root}: ${path}`);
  return relative(root, full);
}

/** The changed, new, and deleted files under the carried paths, relative to the folder. A rename counts as a delete
 *  plus a new file, so both sides move. Ignored files stay behind. */
async function carriedFiles(folder: string, carry: readonly string[]): Promise<string[]> {
  if (carry.length === 0) return [];
  const paths = ["--", ...carry.map((path) => carriedPath(folder, path))];
  const git = async (args: string[]) =>
    (await exec("git", ["--literal-pathspecs", "-C", folder, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout;
  const [tracked, untracked] = await Promise.all([
    git(["diff", "--name-only", "--no-renames", "--relative", "-z", "HEAD", ...paths]),
    git(["ls-files", "--others", "--exclude-standard", "-z", ...paths]),
  ]);
  return [...new Set(`${tracked}${untracked}`.split("\0").filter(Boolean))];
}

/** Copies each file to the same place in the new worktree, uncommitted, and deletes the ones deleted here. A folder
 *  inside the repo keeps its place, so `gui/package.json` never lands on the root one. The old folder is untouched. */
async function carryFiles(from: string, worktree: string, files: readonly string[]): Promise<void> {
  if (files.length === 0) return;
  const prefix = (await exec("git", ["-C", from, "rev-parse", "--show-prefix"])).stdout.trim();
  const root = await realpath(worktree);
  for (const file of files) {
    const source = resolve(from, file);
    const target = resolve(worktree, prefix, file);
    const deleted = (await lstat(source).catch(() => null)) === null;
    if (!deleted) await mkdir(dirname(target), { recursive: true });
    const parent = await realpath(dirname(target)).catch(() => null);
    if (parent === null) continue;
    // A symlinked folder in the new worktree must not lead the copy outside it.
    if (!inside(root, parent)) throw new Error(`${file} would land outside the new worktree.`);
    if (deleted) await rm(target, { force: true });
    else await cp(source, target, { recursive: true, force: true, verbatimSymlinks: true });
  }
}
