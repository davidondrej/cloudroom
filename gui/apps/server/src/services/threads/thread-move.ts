import { eq } from "drizzle-orm";
import {
  createEventId,
  environmentHasLiveThreads,
  environments,
  findProjectEnvironmentByHostPath,
  getEnvironment,
  getProject,
  getProjectSourceByHost,
  getThread,
  listPublicProjects,
  listUnarchivedAssignedChildThreads,
  updateThread,
  type DbTransaction,
  type ProjectRow,
} from "@cloudroom/db";
import {
  THREAD_HARNESS_SWITCH_OPERATION,
  threadScope,
  type Thread,
} from "@cloudroom/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { cloudroom, isCloudThread } from "../cloudroom/commands.js";
import { macAccess } from "../cloudroom/previews.js";
import { teleportBlocked } from "../cloudroom/store.js";
import { assertEnvironmentPathAvailable } from "../environments/path-admission.js";
import { requirePrimaryHostId } from "../hosts/primary-host.js";
import { withThreadContextClearGuard } from "./thread-context-mutation-guard.js";
import {
  provisionUnmanagedEnvironmentForPath,
  resolveReadyEnvironment,
} from "./thread-environment-directory.js";
import {
  appendThreadEvent,
  appendThreadEventInTransaction,
} from "./thread-events.js";
import { setThreadReadyHook } from "./queued-message-dispatch.js";
import { historySeed } from "./thread-harness-switch.js";
import { stopThreadForCurrentState } from "./thread-lifecycle.js";

export interface ThreadMoveResult {
  thread: Thread;
  moved: boolean;
  previousPath: string | null;
}

export type MoveRequester = "local" | "cloud-agent";

const AGENT_MOVE_REFUSED =
  "The agent asked to move this thread to another project. Cloudroom didn't move it because Mac access isn't Full. Move it from the thread menu.";

const pendingMoves = new Map<
  string,
  { projectId: string; requestedBy: MoveRequester }
>();

export async function moveThreadToProject(
  deps: AppDeps,
  threadId: string,
  projectRef: string,
  requestedBy: MoveRequester,
): Promise<ThreadMoveResult> {
  const allowed = requestedBy === "local" || (await macAccess(deps)) === "full";
  const thread = getThread(deps.db, threadId);
  if (!thread || thread.deletedAt !== null) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  if (thread.archivedAt !== null) {
    throw new ApiError(
      409,
      "thread_not_writable",
      "Unarchive the thread, then move it.",
    );
  }
  if (!allowed) refuseAgentMove(deps, thread);
  const project = resolveProject(deps, projectRef);
  if (project.id === thread.projectId) {
    pendingMoves.delete(thread.id);
    return { thread, moved: true, previousPath: null };
  }
  const children = listUnarchivedAssignedChildThreads(deps.db, {
    parentThreadId: thread.id,
  });
  if (children.some((child) => !isSettled(child))) {
    throw new ApiError(
      409,
      "thread_busy",
      "Wait until this thread's subagents finish, then move it.",
    );
  }
  if (
    !isSettled(thread) ||
    deps.pendingInteractions.hasPendingThreadInteraction(thread.id) ||
    teleportBlocked(deps.db, thread.id)
  ) {
    pendingMoves.set(thread.id, { projectId: project.id, requestedBy });
    return { thread, moved: false, previousPath: null };
  }
  pendingMoves.delete(thread.id);
  const previousPath = await withThreadContextClearGuard(thread.id, () =>
    isCloudThread(thread)
      ? cloudroom(deps).moveProject(thread, project.id, () =>
          moveRecord(deps, thread, project, null, thread.environmentId),
        )
      : moveLocalThread(deps, thread, project),
  );
  return {
    thread: getThread(deps.db, thread.id) ?? thread,
    moved: true,
    previousPath,
  };
}

export function installThreadMoves(deps: AppDeps): void {
  setThreadReadyHook(deps.db, (threadId) =>
    applyPendingThreadMove(deps, threadId),
  );
  deps.hub.onThreadChanged((threadId, changes) => {
    if (!changes.includes("status-changed") || !pendingMoves.has(threadId))
      return;
    const thread = getThread(deps.db, threadId);
    if (thread && isCloudThread(thread) && isSettled(thread))
      setImmediate(() => void applyPendingThreadMove(deps, threadId));
  });
  cloudroom(deps).moveRequest = (threadId, project) =>
    void moveThreadToProject(deps, threadId, project, "cloud-agent").catch(
      (error: unknown) =>
        deps.logger.warn({ error, threadId }, "Cloud self-move failed"),
    );
}

function refuseAgentMove(deps: AppDeps, thread: Thread): never {
  appendThreadEvent(deps, {
    threadId: thread.id,
    environmentId: thread.environmentId,
    type: "system/operation",
    scope: threadScope(),
    data: {
      operation: "thread_move",
      operationId: createEventId(),
      status: "failed",
      message: AGENT_MOVE_REFUSED,
    },
  });
  throw new ApiError(403, "mac_access", AGENT_MOVE_REFUSED);
}

async function applyPendingThreadMove(
  deps: AppDeps,
  threadId: string,
): Promise<void> {
  const pending = pendingMoves.get(threadId);
  if (pending === undefined) return;
  pendingMoves.delete(threadId);
  try {
    await moveThreadToProject(
      deps,
      threadId,
      pending.projectId,
      pending.requestedBy,
    );
  } catch (error) {
    if (error instanceof ApiError && error.body.code === "thread_busy") {
      if (!pendingMoves.has(threadId)) pendingMoves.set(threadId, pending);
      return;
    }
    deps.logger.warn({ error, threadId }, "Thread move failed");
  }
}

function isSettled(thread: Pick<Thread, "status">): boolean {
  return thread.status === "idle" || thread.status === "error";
}

function resolveProject(deps: AppDeps, ref: string): ProjectRow {
  const byId = getProject(deps.db, ref);
  if (byId) return byId;
  const name = ref.trim().toLowerCase();
  const named = listPublicProjects(deps.db).filter(
    (project) => project.name.toLowerCase() === name,
  );
  if (named.length === 1) return named[0]!;
  throw new ApiError(
    404,
    "project_not_found",
    named.length > 1
      ? `More than one project is named ${ref}. Use its ID from \`room-cli project list\`.`
      : `No project named ${ref}. See \`room-cli project list\`.`,
  );
}

async function moveLocalThread(
  deps: AppDeps,
  thread: Thread,
  project: ProjectRow,
): Promise<string | null> {
  const current = thread.environmentId
    ? getEnvironment(deps.db, thread.environmentId)
    : null;
  const hostId = current?.hostId ?? requirePrimaryHostId(deps);
  const source = getProjectSourceByHost(deps.db, project.id, hostId);
  if (!source || source.type !== "local_path") {
    throw new ApiError(
      409,
      "project_not_on_machine",
      `${project.name} has no folder on this machine. Add one in its project settings, then move the thread.`,
    );
  }
  assertEnvironmentPathAvailable(deps, {
    hostId,
    path: source.path,
    threadId: thread.id,
  });
  const existing = findProjectEnvironmentByHostPath(
    deps.db,
    project.id,
    hostId,
    source.path,
  );
  const target = existing
    ? resolveReadyEnvironment(existing)
    : await provisionUnmanagedEnvironmentForPath(deps, {
        hostId,
        path: source.path,
        projectId: project.id,
      });
  if ("failure" in target) {
    throw new ApiError(409, "environment_not_ready", target.failure);
  }
  await stopThreadForCurrentState(deps, thread, current);
  const record = await moveRecord(
    deps,
    thread,
    project,
    target.path,
    target.id,
  );
  deps.db.transaction((tx) => {
    updateThread(tx, deps.hub, thread.id, {
      projectId: project.id,
      environmentId: target.id,
    });
    record(tx);
  });
  if (
    current?.environmentProviderId &&
    !environmentHasLiveThreads(deps.db, current.id)
  ) {
    deps.db
      .update(environments)
      .set({ environmentProviderId: null, retireAt: null })
      .where(eq(environments.id, current.id))
      .run();
  }
  return current?.path ?? null;
}

async function moveRecord(
  deps: AppDeps,
  thread: Thread,
  project: ProjectRow,
  path: string | null,
  environmentId: string | null,
): Promise<(tx: DbTransaction) => void> {
  const from = getProject(deps.db, thread.projectId)?.name ?? "previous";
  const folder = path
    ? `Your working folder is now ${path}.`
    : "Your working folder is now this project's folder. Run `room-cli files wait` before you rely on its files.";
  const seed = await historySeed(
    deps,
    thread,
    `[Cloudroom] This thread moved from the ${from} project to the ${project.name} project. ${folder} The old project's folder is unchanged.`,
    project.id,
  );
  return (tx) =>
    appendThreadEventInTransaction(tx, {
      threadId: thread.id,
      environmentId,
      type: "system/operation",
      scope: threadScope(),
      data: {
        operation: THREAD_HARNESS_SWITCH_OPERATION,
        operationId: createEventId(),
        status: "completed",
        message: `Moved from ${from} to ${project.name}.`,
        metadata: {
          from: thread.providerId,
          to: thread.providerId,
          fromProject: thread.projectId,
          toProject: project.id,
          seed,
        },
      },
    });
}
