import { execFile } from "node:child_process";
import { cp, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { and, asc, desc, eq, gt, sql, type SQL } from "drizzle-orm";
import {
  createEventId,
  events,
  findStoredEventRow,
  getEnvironment,
  getThread,
  updateThread,
  type DbQueryConnection,
  type EnvironmentRow,
} from "@cloudroom/db";
import {
  PERSONAL_PROJECT_ID,
  THREAD_HARNESS_SWITCH_OPERATION,
  threadScope,
  type PromptInput,
  type Thread,
} from "@cloudroom/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { prepareLocalForkWorktree } from "../cloudroom/fork.js";
import {
  cancelProviderEnvironmentCreation,
  markProviderEnvironmentAttached,
  staleWorkspaceMessage,
} from "../environments/environment-engine.js";
import { ENVIRONMENT_HOOK_TIMEOUT_MS } from "../environments/environment-hooks.js";
import { DEFAULT_ENVIRONMENT_PROVIDER_ID } from "../environments/environment-provider-ids.js";
import { requireWorkspaceCommandTarget } from "../environments/workspace-command-target.js";
import { callEnvironmentWorkspaceStatusForWork } from "../environments/workspace-status.js";
import { runLiveHostCommand } from "../hosts/live-command.js";
import { resolvePrimaryHostId } from "../hosts/primary-host.js";
import { getEnvironmentProvider } from "../plugins/plugin-environment-provider-registry.js";
import type { DeferredFirstTurnContext } from "./deferred-first-turn-context.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import { withThreadContextClearGuard } from "./thread-context-mutation-guard.js";
import { buildEnvironmentProvisionCommand } from "./thread-create-helpers.js";
import {
  prepareProviderEnvironment,
  resolveNewWorktreeOperationContext,
  worktreeProviderInputs,
} from "./thread-environment-placement.js";
import {
  appendThreadEvent,
  appendThreadEventInTransaction,
} from "./thread-events.js";
import { historySeed } from "./thread-harness-switch.js";
import { stopThreadForCurrentState } from "./thread-lifecycle.js";
import { latestOperationSeed } from "./thread-transcript.js";

// `room-cli thread worktree` moves a Local thread into a new Cloudroom-managed worktree. It keeps its ID and chat,
// like a project move. The worktree starts from the thread's current commit when its turn ends. Other agents may
// share the old checkout, so only the uncommitted files the agent names come along (David, 2026-11-07).
// It works for every agent and names none: each provider declares `resumesInNewFolder`. One that can't resume its
// session in another folder starts a fresh one there with the chat as hidden context, like a project move.

const exec = promisify(execFile);
const OPERATION = "thread_worktree_move";
const SETUP_TIMEOUT_MS = 20 * 60_000;
const BUSY = "This thread is moving to a new worktree. Try again in a moment.";
const TURN_STARTED = "turn_started_during_move";

/** Threads waiting for their turn to end: the paths they carry, relative to their folder, and the move's timeline entry. */
interface Request {
  carry: string[];
  from: string;
  operationId: string;
}
const pending = new Map<string, Request>();
const moving = new Set<string>();

const note = (
  deps: AppDeps,
  threadId: string,
  request: Request,
  status: "started" | "completed" | "failed",
  message: string,
  agentNote?: string,
) =>
  appendThreadEvent(deps, {
    threadId,
    environmentId: getThread(deps.db, threadId)?.environmentId ?? null,
    type: "system/operation",
    scope: threadScope(),
    data: {
      operation: OPERATION,
      operationId: request.operationId,
      status,
      message,
      // The agent never sees timeline events, so its next turn starts with this note (#1282).
      ...(agentNote === undefined
        ? {}
        : {
            metadata: {
              seed: [
                {
                  type: "text",
                  text: agentNote,
                  mentions: [],
                  visibility: "agent-only",
                } satisfies PromptInput,
              ],
            },
          }),
    },
  });

export function requestThreadWorktreeMove(
  deps: AppDeps,
  threadId: string,
  carry: readonly string[],
): { previousPath: string } {
  const { thread, folder } = movable(deps, threadId, carry);
  for (const path of carry) carriedPath(folder.path, path);
  if (pending.has(thread.id) || moving.has(thread.id))
    throw new ApiError(
      409,
      "thread_busy",
      "This thread is already moving to a new worktree.",
    );
  const request = {
    carry: [...carry],
    from: folder.path,
    operationId: createEventId(),
  };
  pending.set(thread.id, request);
  const now = settled(deps, thread);
  // Saved now, so a restart that clears `pending` still tells the agent its move never ran.
  note(
    deps,
    thread.id,
    request,
    "started",
    now
      ? "Moving this thread to a new worktree"
      : "Moves to a new worktree when this turn ends",
    `Cloudroom restarted before this thread's move to a new worktree finished, so it still runs in ${folder.path}. Run \`room-cli thread worktree\` again.`,
  );
  if (now) void applyPendingThreadWorktreeMove(deps, thread.id);
  return { previousPath: folder.path };
}

/** The note the agent's next turn must carry when its last move failed or never ran. */
export function pendingWorktreeMoveNote(
  db: DbQueryConnection,
  threadId: string,
  clearedSequence: number,
): DeferredFirstTurnContext | null {
  if (pending.has(threadId) || moving.has(threadId)) return null;
  return pendingOperationNote(db, threadId, clearedSequence, OPERATION);
}

/** The note saved on this operation's newest event, until a turn delivers it. Only a turn whose request carried the
 *  note uses it up: one that started while a move hid it, or that the harness started itself, never saw it. A
 *  context clear after the note drops it before any search, since no request will carry it. */
export function pendingOperationNote(
  db: DbQueryConnection,
  threadId: string,
  clearedSequence: number,
  operation: string,
): DeferredFirstTurnContext | null {
  const note = latestOperationSeed(db, threadId, [operation]);
  const text = note?.input[0]?.type === "text" ? note.input[0].text : null;
  if (!note || text === null || note.requestSequence <= clearedSequence)
    return null;
  const carrier = (order: SQL) =>
    db
      .select({
        sequence: events.sequence,
        chain: sql<string>`coalesce(json_extract(${events.data}, '$.retryOfRequestId'), json_extract(${events.data}, '$.requestId'))`,
      })
      .from(events)
      .where(
        and(
          eq(events.threadId, threadId),
          eq(events.type, "client/turn/requested"),
          gt(events.sequence, note.requestSequence),
          sql`EXISTS (SELECT 1 FROM json_each(${events.data}, '$.input') WHERE json_extract(value, '$.text') = ${text})`,
        ),
      )
      .orderBy(order)
      .limit(1)
      .get();
  // The first carrier is normally the first request after the note, so a delivered note costs one parsed row.
  const first = carrier(asc(events.sequence));
  if (!first) return note;
  if (
    findStoredEventRow(db, {
      threadId,
      type: "turn/started",
      afterSequence: first.sequence,
    })
  )
    return null;
  // Not delivered yet: every carrier since failed, and the newest one's retry chain already holds the note.
  return {
    ...note,
    retryChainRequestId: (carrier(desc(events.sequence)) ?? first).chain,
  };
}

/** Runs from the thread-ready hook, before queued messages, so they start in the new worktree. */
export async function applyPendingThreadWorktreeMove(
  deps: AppDeps,
  threadId: string,
): Promise<void> {
  const request = pending.get(threadId);
  const thread = getThread(deps.db, threadId);
  if (request === undefined || !thread || !settled(deps, thread)) return;
  pending.delete(threadId);
  moving.add(threadId);
  try {
    // Sends wait until the move ends, so no turn starts in the old folder; queued messages stay queued.
    const { from, to } = await withThreadContextClearGuard(
      threadId,
      () => moveToNewWorktree(deps, threadId, request.carry),
      BUSY,
    );
    note(
      deps,
      threadId,
      request,
      "completed",
      `Moved from ${from} to a new worktree at ${to}.`,
    );
  } catch (error) {
    // Removes the new worktree if the thread never switched to it.
    await cancelProviderEnvironmentCreation(deps, threadId).catch(
      (cleanup: unknown) =>
        deps.logger.warn(
          { threadId, error: cleanup },
          "New worktree cleanup failed",
        ),
    );
    // A turn the agent started itself during setup, e.g. when a background task ended: move when that turn ends.
    if (error instanceof ApiError && error.body.code === TURN_STARTED)
      pending.set(threadId, request);
    else {
      const reason = error instanceof Error ? error.message : String(error);
      note(
        deps,
        threadId,
        request,
        "failed",
        `Could not move to a new worktree: ${reason}`,
        `Cloudroom could not move this thread to a new worktree, so it still runs in ${request.from}: ${reason.replace(/\.?$/u, ".")} Fix the cause and run \`room-cli thread worktree\` again, or tell the user.`,
      );
    }
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
  const { thread, folder, local } = movable(deps, threadId, carry);
  const record = getEnvironmentProvider(DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree);
  if (!record) throw new ApiError(409, "worktree_plugin_off", "Turn on the Worktree plugin in Settings → Plugins.");
  const head = await (local ? localHead(folder.path) : remoteHead(deps, folder));
  if (!head) throw new ApiError(409, "not_a_git_checkout", `${folder.path} is not a Git checkout with commits.`);
  const files = local ? await carriedFiles(folder.path, carry) : [];
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
  if (created.status !== "ready") {
    const attached = await runLiveHostCommand(deps, {
      hostId: folder.hostId,
      command: buildEnvironmentProvisionCommand({
        environmentId: created.id,
        hostId: folder.hostId,
        initiator: null,
        path: created.path!,
        setupScriptTimeoutMs: ENVIRONMENT_HOOK_TIMEOUT_MS,
        // Hooks come from where the source branched off its base: the new worktree starts from the thread's own
        // commit, which an agent may have made, and its carried files are uncommitted.
        hookBaseBranch: folder.mergeBaseBranch,
      }),
      timeoutMs: SETUP_TIMEOUT_MS,
    });
    // Settling already refused that folder; this says why, and the thread stays where it is (#2216).
    if (attached.path !== created.path)
      throw new Error(staleWorkspaceMessage(attached.path));
  }
  const ready = getEnvironment(deps.db, created.id);
  if (ready?.status !== "ready" || !ready.path) throw new Error(ready?.statusMessage ?? "The worktree setup did not finish.");
  const seed = deps.providerRegistry.resumesInNewFolder(thread.providerId)
    ? null
    : await historySeed(
        deps,
        thread,
        `[Cloudroom] This thread moved into its own worktree. Your working folder is now ${ready.path}. Work only there; never edit the old folder ${folder.path}.`,
      );
  const current = getThread(deps.db, threadId);
  if (!current || !settled(deps, current))
    throw new ApiError(
      409,
      TURN_STARTED,
      "A new turn started before the worktree was ready.",
    );
  // The agent restarts in the new folder on its next turn.
  await stopThreadForCurrentState(deps, current, folder);
  deps.db.transaction((tx) => {
    updateThread(tx, deps.hub, threadId, { environmentId: ready.id });
    markProviderEnvironmentAttached(tx, threadId, ready.id);
    // This event drops the old native session, so the next turn starts a fresh one that reads the seed.
    if (seed)
      appendThreadEventInTransaction(tx, {
        threadId,
        environmentId: ready.id,
        type: "system/operation",
        scope: threadScope(),
        data: {
          operation: THREAD_HARNESS_SWITCH_OPERATION,
          operationId: createEventId(),
          status: "completed",
          message: "Continues in a fresh session in the new worktree.",
          metadata: { from: thread.providerId, to: thread.providerId, seed },
        },
      });
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

const localHead = (path: string) =>
  exec("git", ["-C", path, "rev-parse", "HEAD"], { windowsHide: true }).then(({ stdout }) => stdout.trim(), () => null);

/** Another computer's HEAD comes from its own host daemon; this process can't read its folders. */
async function remoteHead(deps: AppDeps, folder: EnvironmentRow): Promise<string | null> {
  const result = await callEnvironmentWorkspaceStatusForWork(deps, {
    environment: folder,
    target: requireWorkspaceCommandTarget(folder),
  });
  const checkout = result.outcome === "available" ? result.workspaceStatus.checkout : null;
  return checkout && "headSha" in checkout ? checkout.headSha : null;
}

function movable(
  deps: AppDeps,
  threadId: string,
  carry: readonly string[],
): { thread: Thread; folder: EnvironmentRow & { path: string }; local: boolean } {
  const thread = getThread(deps.db, threadId);
  if (!thread || thread.deletedAt !== null) throw new ApiError(404, "thread_not_found", "Thread not found");
  if (thread.archivedAt !== null) throw new ApiError(409, "thread_not_writable", "Unarchive the thread, then move it.");
  if (thread.executionTarget === "cloud")
    throw new ApiError(409, "cloud_thread", "Cloud threads already run in their own sandbox.");
  if (thread.projectId === PERSONAL_PROJECT_ID)
    throw new ApiError(409, "personal_thread", "Only project threads can move into a worktree.");
  const folder = thread.environmentId ? getEnvironment(deps.db, thread.environmentId) : null;
  if (!folder?.path) throw new ApiError(409, "no_folder", "This thread has no folder yet.");
  // Another computer's thread moves without carried files: copying them would need its own file access.
  const local = folder.hostId === resolvePrimaryHostId(deps);
  if (!local && carry.length > 0)
    throw new ApiError(409, "other_machine", "This thread runs on another computer, so it can move only without --carry. Commit the files first.");
  if (folder.environmentProviderId === DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree)
    throw new ApiError(409, "already_worktree", "This thread already has its own worktree.");
  return { thread, folder: { ...folder, path: folder.path }, local };
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
    (await exec("git", ["--literal-pathspecs", "-C", folder, ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true })).stdout;
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
  const prefix = (await exec("git", ["-C", from, "rev-parse", "--show-prefix"], { windowsHide: true })).stdout.trim();
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
