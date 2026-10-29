import {
  getThread,
  listNonDeletedChildThreads,
  listQueuedThreadMessages,
  listUnarchivedAssignedChildThreads,
  type DbConnection,
} from "@cloudroom/db";
import type { Thread, ThreadStatus } from "@cloudroom/domain";
import type { AppDeps } from "../../types.js";
import { throwParentThreadInvalid } from "../lib/lifecycle-api-errors.js";

import { teleportBlocked } from "../cloudroom/store.js";
import { ApiError } from "../../errors.js";

const MAX_THREAD_HIERARCHY_DEPTH = 4;

export function isAgentDelegatedChildThread<
  T extends Pick<Thread, "parentThreadId">,
>(thread: T): thread is T & { parentThreadId: string } {
  return thread.parentThreadId !== null;
}

export function isParentNotifiableChildThread<
  T extends Pick<Thread, "parentThreadId" | "originKind">,
>(thread: T): thread is T & { parentThreadId: string } {
  return isAgentDelegatedChildThread(thread) && thread.originKind === null;
}

const BUSY_THREAD_STATUSES: ReadonlySet<ThreadStatus> = new Set([
  "pending",
  "starting",
  "active",
  "stopping",
]);

function hasBusyDescendantThread(db: DbConnection, threadId: string): boolean {
  return listUnarchivedAssignedChildThreads(db, {
    parentThreadId: threadId,
  }).some(
    (child) =>
      BUSY_THREAD_STATUSES.has(child.status) ||
      hasBusyDescendantThread(db, child.id),
  );
}

export function isHardQueueHeld(
  db: DbConnection,
  thread: Pick<Thread, "id" | "status">,
): boolean {
  return (
    (thread.status !== "idle" && thread.status !== "pending") ||
    listQueuedThreadMessages(db, thread.id).some(
      (row) => row.systemNotice !== null,
    ) ||
    hasBusyDescendantThread(db, thread.id)
  );
}

export type ParentThread = Pick<
  Thread,
  | "archivedAt"
  | "deletedAt"
  | "environmentId"
  | "id"
  | "parentThreadId"
  | "projectId"
> &
  Partial<Pick<Thread, "originKind">>;

interface IsLiveParentThreadArgs {
  parentThread: ParentThread | null;
}

interface AssertValidParentThreadArgs {
  childThreadId?: string;
  parentThreadId: string;
  /** A Cloud child in a sandbox of its own may have a Cloud parent (ADR 0228). */
  cloudChild?: boolean;
}

interface ResolveParentDepthArgs {
  childThreadId?: string;
  parentThread: ParentThread;
}

interface ResolveThreadSubtreeDepthArgs {
  threadId: string;
  visitedThreadIds: Set<string>;
}

export function isLiveParentThread(args: IsLiveParentThreadArgs): boolean {
  return (
    args.parentThread !== null &&
    args.parentThread.archivedAt === null &&
    args.parentThread.deletedAt === null
  );
}

function resolveParentDepth(
  deps: Pick<AppDeps, "db">,
  args: ResolveParentDepthArgs,
): number {
  let depth = 0;
  let parentThread: ParentThread | null = args.parentThread;
  const visitedThreadIds = new Set<string>();

  while (parentThread !== null) {
    if (args.childThreadId && parentThread.id === args.childThreadId) {
      throwParentThreadInvalid(
        parentThread.id === args.parentThread.id ? "self" : "cycle",
      );
    }
    if (visitedThreadIds.has(parentThread.id)) {
      throwParentThreadInvalid("cycle");
    }
    visitedThreadIds.add(parentThread.id);
    depth += 1;

    if (parentThread.parentThreadId === null) {
      return depth;
    }

    parentThread = getThread(deps.db, parentThread.parentThreadId);
  }

  return depth;
}

function resolveThreadSubtreeDepth(
  deps: Pick<AppDeps, "db">,
  args: ResolveThreadSubtreeDepthArgs,
): number {
  if (args.visitedThreadIds.has(args.threadId)) {
    throwParentThreadInvalid("cycle");
  }
  args.visitedThreadIds.add(args.threadId);

  const childThreads = listNonDeletedChildThreads(deps.db, {
    parentThreadId: args.threadId,
  });
  let maxChildDepth = 0;
  for (const childThread of childThreads) {
    const childDepth = resolveThreadSubtreeDepth(deps, {
      threadId: childThread.id,
      visitedThreadIds: args.visitedThreadIds,
    });
    maxChildDepth = Math.max(maxChildDepth, childDepth);
  }
  args.visitedThreadIds.delete(args.threadId);

  return maxChildDepth + 1;
}

interface CanThreadSpawnChildArgs {
  thread: ParentThread;
}

export function canThreadSpawnChild(
  deps: Pick<AppDeps, "db">,
  args: CanThreadSpawnChildArgs,
): boolean {
  if (teleportBlocked(deps.db, args.thread.id)) return false;
  const depth = resolveParentDepth(deps, {
    parentThread: args.thread,
  });
  return depth < MAX_THREAD_HIERARCHY_DEPTH;
}

export function assertValidParentThread(
  deps: Pick<AppDeps, "db">,
  args: AssertValidParentThreadArgs,
): Thread {
  const parentThread = getThread(deps.db, args.parentThreadId);
  if (teleportBlocked(deps.db, args.parentThreadId) || (parentThread?.executionTarget === "cloud" && !args.cloudChild)) throw new ApiError(409, "teleport_in_progress", "Local children cannot start during or after Teleport.");
  if (parentThread === null) {
    throwParentThreadInvalid("not_found");
  }
  const liveParentThread: Thread = parentThread;

  if (liveParentThread.archivedAt !== null) {
    throwParentThreadInvalid("archived");
  }
  if (liveParentThread.deletedAt !== null) {
    throwParentThreadInvalid("deleted");
  }
  const parentDepth = resolveParentDepth(deps, {
    childThreadId: args.childThreadId,
    parentThread: liveParentThread,
  });
  const childSubtreeDepth = args.childThreadId
    ? resolveThreadSubtreeDepth(deps, {
        threadId: args.childThreadId,
        visitedThreadIds: new Set<string>(),
      })
    : 1;
  if (parentDepth + childSubtreeDepth > MAX_THREAD_HIERARCHY_DEPTH) {
    throwParentThreadInvalid("too_deep");
  }

  return liveParentThread;
}
