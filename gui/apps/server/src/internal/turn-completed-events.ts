import {
  findLastRootStoredTurnStarted,
  getLastStoredTurnRequestEvent,
  getThread,
  hasRootStoredTurnStarted,
  listStoredTurnCompletedRowsByTurnIds,
} from "@cloudroom/db";
import {
  requireThreadEventScopeTurnId,
  type ThreadEvent,
  type ThreadLifecycleEvent,
  type ThreadStatus,
} from "@cloudroom/domain";
import type { AppDeps } from "../types.js";
import {
  pruneThreadEventHistoryBestEffort,
  resetActiveThreadEventPruningState,
} from "../services/system/event-pruning.js";
import { applyLoggedThreadLifecycleEvent } from "../services/threads/lifecycle-outcome.js";

interface ApplyTurnCompletedEventResult {
  isRootTurnCompletion: boolean;
  nextStatus: ThreadStatus | null;
  thread: ReturnType<typeof getThread>;
}

function isLatestRun(
  deps: Pick<AppDeps, "db">,
  args: { threadId: string; turnId: string },
): boolean {
  const started = findLastRootStoredTurnStarted(deps.db, {
    threadId: args.threadId,
  });
  if (started?.turnId !== args.turnId) return false;
  const completions = listStoredTurnCompletedRowsByTurnIds(deps.db, {
    threadId: args.threadId,
    turnIds: [args.turnId],
  });
  const [first, second] = completions;
  const request = getLastStoredTurnRequestEvent(deps.db, args.threadId);
  return (
    first === undefined ||
    second === undefined ||
    request === null ||
    request.sequence < first.sequence
  );
}

function lifecycleEventForTurnCompletion(
  status: Extract<ThreadEvent, { type: "turn/completed" }>["status"],
  threadStatus: ThreadStatus,
): ThreadLifecycleEvent {
  if (status === "failed") {
    return { type: "run.failed" };
  }
  if (status === "interrupted" && threadStatus === "stopping") {
    return { type: "stop.settled" };
  }
  return { type: "run.succeeded" };
}

export function applyTurnCompletedEvent(
  deps: Pick<AppDeps, "db" | "hub" | "logger" | "providerRegistry">,
  payload: Extract<ThreadEvent, { type: "turn/completed" }>,
): ApplyTurnCompletedEventResult {
  const thread = getThread(deps.db, payload.threadId);
  if (!thread) {
    return { isRootTurnCompletion: false, nextStatus: null, thread: null };
  }

  const turnId = requireThreadEventScopeTurnId({
    type: payload.type,
    scope: payload.scope,
  });
  const isRootTurnCompletion = hasRootStoredTurnStarted(deps.db, {
    threadId: payload.threadId,
    turnId,
  });
  if (!isRootTurnCompletion) {
    return { isRootTurnCompletion, nextStatus: null, thread };
  }
  if (
    thread.status !== "stopping" &&
    !isLatestRun(deps, { threadId: payload.threadId, turnId })
  ) {
    return { isRootTurnCompletion: false, nextStatus: null, thread };
  }

  const outcome = applyLoggedThreadLifecycleEvent(deps, {
    event: lifecycleEventForTurnCompletion(payload.status, thread.status),
    threadId: payload.threadId,
  });
  const nextStatus = outcome.applied ? outcome.thread.status : null;

  if (nextStatus) {
    resetActiveThreadEventPruningState(payload.threadId);
  }

  if (nextStatus === "idle") {
    pruneThreadEventHistoryBestEffort(deps, {
      mode: "idle",
      threadId: payload.threadId,
    });
  }

  return { isRootTurnCompletion, nextStatus, thread };
}
