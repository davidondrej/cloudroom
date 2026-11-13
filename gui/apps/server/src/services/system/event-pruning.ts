import { performance } from "node:perf_hooks";
import {
  getThread,
  getLatestThreadSequence,
  pruneBackgroundTaskProgressEvents,
  pruneContextWindowUsageEventsBeforeSequence,
  pruneResolvedItemDeltas,
  pruneTokenUsageEventsBeforeSequence,
  pruneThreadEventsBeforeSequence,
  threads,
} from "@cloudroom/db";
import type { DbConnection } from "@cloudroom/db";
import type { ThreadEventType } from "@cloudroom/domain";
import { roundDurationMs } from "@cloudroom/process-utils";
import type { AppDeps } from "../../types.js";
import { runEventLoopWorkSync } from "./event-loop-work.js";

type ThreadEventPruningMode = "active" | "archived" | "idle";

interface PruneThreadEventHistoryArgs {
  mode: ThreadEventPruningMode;
  threadId: string;
}

interface ThreadEventPruningResult {
  latestSequence: number;
  removedAgePrunableEvents: number;
  removedBackgroundTaskProgressEvents: number;
  removedResolvedItemDeltas: number;
  sequenceCutoff: number;
  totalRemoved: number;
}

interface MaybePruneActiveThreadEventHistoryArgs {
  latestPrunableSequence: number;
  threadId: string;
}

interface ActiveThreadPruneState {
  lastPrunedAt: number;
  lastPrunedSequence: number;
}

type ThreadEventPruningStep =
  | "get_latest_thread_sequence"
  | "prune_background_task_progress"
  | "prune_context_window_usage"
  | "prune_generic_age_prunable_events"
  | "prune_resolved_item_deltas"
  | "prune_token_usage";

class ThreadEventPruningStepError extends Error {
  readonly step: ThreadEventPruningStep;

  constructor(step: ThreadEventPruningStep, cause: ErrorOptions["cause"]) {
    super(`Thread event pruning step failed: ${step}`, { cause });
    this.name = "ThreadEventPruningStepError";
    this.step = step;
  }
}

const ACTIVE_THREAD_EVENT_KEEP_RECENT = 1_000;
const IDLE_THREAD_EVENT_KEEP_RECENT = 300;
const ARCHIVED_THREAD_EVENT_KEEP_RECENT = 120;
const ACTIVE_THREAD_EVENT_PRUNE_MIN_SEQUENCE_DELTA = 250;
const ACTIVE_THREAD_EVENT_PRUNE_MIN_INTERVAL_MS = 30_000;
const SLOW_THREAD_EVENT_PRUNE_LOG_THRESHOLD_MS = 1_000;
// The sweep that deletes leftover streamed pieces: how long one tick may work, how many rows one step deletes,
// and how slow a step may be before the tick stops. Old rows sit cold on disk, where a large delete would freeze
// the server for a moment, so steps are small and a slow one ends the tick.
const LEFTOVER_STREAM_PIECE_SWEEP_BUDGET_MS = 250;
const LEFTOVER_STREAM_PIECE_SWEEP_BATCH_SIZE = 100;
const LEFTOVER_STREAM_PIECE_SWEEP_SLOW_STEP_MS = 50;

// Threads that may still hold streamed pieces of finished items. One prune deletes one bounded batch, so a long
// turn leaves pieces behind, and so did every Cloud thread from before Cloud turns pruned at all.
interface LeftoverStreamPieceQueue {
  backlogQueued: boolean;
  threadIds: Set<string>;
}
const leftoverStreamPieceQueues = new WeakMap<
  DbConnection,
  LeftoverStreamPieceQueue
>();

function leftoverStreamPieceQueue(db: DbConnection): LeftoverStreamPieceQueue {
  let queue = leftoverStreamPieceQueues.get(db);
  if (!queue) {
    queue = { backlogQueued: false, threadIds: new Set() };
    leftoverStreamPieceQueues.set(db, queue);
  }
  return queue;
}

const AGE_PRUNABLE_THREAD_EVENT_TYPES: readonly ThreadEventType[] = [
  "thread/contextWindowUsage/updated",
  "thread/tokenUsage/updated",
  "turn/diff/updated",
] as const;

const ACTIVE_PRUNE_TRIGGER_THREAD_EVENT_TYPES: readonly ThreadEventType[] = [
  ...AGE_PRUNABLE_THREAD_EVENT_TYPES,
  "item/backgroundTask/progress",
] as const;

const GENERIC_AGE_PRUNABLE_THREAD_EVENT_TYPES: readonly ThreadEventType[] = [
  "turn/diff/updated",
] as const;

const KEEP_RECENT_BY_MODE: Record<ThreadEventPruningMode, number> = {
  active: ACTIVE_THREAD_EVENT_KEEP_RECENT,
  idle: IDLE_THREAD_EVENT_KEEP_RECENT,
  archived: ARCHIVED_THREAD_EVENT_KEEP_RECENT,
};

const activePruneTriggerThreadEventTypeSet = new Set<ThreadEventType>(
  ACTIVE_PRUNE_TRIGGER_THREAD_EVENT_TYPES,
);
const activeThreadPruneStateByThreadId = new Map<
  string,
  ActiveThreadPruneState
>();

function getThreadEventPruningFailureStep(
  error: ErrorOptions["cause"],
): ThreadEventPruningStep | "unknown" {
  if (error instanceof ThreadEventPruningStepError) {
    return error.step;
  }
  return "unknown";
}

function runThreadEventPruningStep<TValue>(
  step: ThreadEventPruningStep,
  work: () => TValue,
): TValue {
  try {
    return work();
  } catch (error) {
    throw new ThreadEventPruningStepError(step, error);
  }
}

export function isActivePruneTriggerThreadEventType(
  eventType: ThreadEventType,
): boolean {
  return activePruneTriggerThreadEventTypeSet.has(eventType);
}

export function pruneThreadEventHistory(
  deps: Pick<AppDeps, "db">,
  args: PruneThreadEventHistoryArgs,
): ThreadEventPruningResult {
  const latestSequence = runThreadEventPruningStep(
    "get_latest_thread_sequence",
    () =>
      getLatestThreadSequence(deps.db, {
        threadId: args.threadId,
      }),
  );
  const keepRecent = KEEP_RECENT_BY_MODE[args.mode];
  const sequenceCutoff = Math.max(0, latestSequence - keepRecent);
  const removedAgePrunableEvents =
    runThreadEventPruningStep("prune_context_window_usage", () =>
      pruneContextWindowUsageEventsBeforeSequence(deps.db, {
        threadId: args.threadId,
        sequenceCutoff,
      }),
    ) +
    runThreadEventPruningStep("prune_token_usage", () =>
      pruneTokenUsageEventsBeforeSequence(deps.db, {
        threadId: args.threadId,
        sequenceCutoff,
      }),
    ) +
    runThreadEventPruningStep("prune_generic_age_prunable_events", () =>
      pruneThreadEventsBeforeSequence(deps.db, {
        threadId: args.threadId,
        sequenceCutoff,
        types: GENERIC_AGE_PRUNABLE_THREAD_EVENT_TYPES,
      }),
    );
  const removedResolvedItemDeltas = runThreadEventPruningStep(
    "prune_resolved_item_deltas",
    () =>
      pruneResolvedItemDeltas(deps.db, {
        threadId: args.threadId,
      }),
  );
  // A batch that deleted pieces may have left more: the sweep below deletes the rest.
  if (removedResolvedItemDeltas > 0) {
    leftoverStreamPieceQueue(deps.db).threadIds.add(args.threadId);
  }
  const removedBackgroundTaskProgressEvents = runThreadEventPruningStep(
    "prune_background_task_progress",
    () =>
      pruneBackgroundTaskProgressEvents(deps.db, {
        threadId: args.threadId,
      }),
  );

  return {
    latestSequence,
    removedAgePrunableEvents,
    removedBackgroundTaskProgressEvents,
    removedResolvedItemDeltas,
    sequenceCutoff,
    totalRemoved:
      removedAgePrunableEvents +
      removedBackgroundTaskProgressEvents +
      removedResolvedItemDeltas,
  };
}

export function pruneThreadEventHistoryBestEffort(
  deps: Pick<AppDeps, "db" | "logger">,
  args: PruneThreadEventHistoryArgs,
): ThreadEventPruningResult | null {
  const startedAt = performance.now();
  try {
    const result = pruneThreadEventHistory(deps, args);
    const durationMs = performance.now() - startedAt;
    if (durationMs >= SLOW_THREAD_EVENT_PRUNE_LOG_THRESHOLD_MS) {
      deps.logger.debug(
        {
          durationMs: roundDurationMs(durationMs),
          latestSequence: result.latestSequence,
          mode: args.mode,
          threadId: args.threadId,
          totalRemoved: result.totalRemoved,
        },
        "Slow thread event pruning",
      );
    }
    return result;
  } catch (error) {
    deps.logger.warn(
      {
        durationMs: roundDurationMs(performance.now() - startedAt),
        mode: args.mode,
        step: getThreadEventPruningFailureStep(error),
        threadId: args.threadId,
        err: error,
      },
      "Failed to prune thread event history",
    );
    return null;
  }
}

export function maybePruneActiveThreadEventHistory(
  deps: Pick<AppDeps, "db" | "logger">,
  args: MaybePruneActiveThreadEventHistoryArgs,
): ThreadEventPruningResult | null {
  const thread = getThread(deps.db, args.threadId);
  if (
    !thread ||
    (thread.status !== "active" && thread.status !== "idle") ||
    thread.archivedAt !== null
  ) {
    return null;
  }

  const lastState = activeThreadPruneStateByThreadId.get(args.threadId);
  const lastPrunedSequence = lastState?.lastPrunedSequence ?? 0;
  if (
    args.latestPrunableSequence - lastPrunedSequence <
    ACTIVE_THREAD_EVENT_PRUNE_MIN_SEQUENCE_DELTA
  ) {
    return null;
  }

  const now = Date.now();
  const lastPrunedAt = lastState?.lastPrunedAt ?? 0;
  if (now - lastPrunedAt < ACTIVE_THREAD_EVENT_PRUNE_MIN_INTERVAL_MS) {
    return null;
  }

  activeThreadPruneStateByThreadId.set(args.threadId, {
    lastPrunedAt: now,
    lastPrunedSequence: args.latestPrunableSequence,
  });

  return pruneThreadEventHistoryBestEffort(deps, {
    mode: thread.status === "active" ? "active" : "idle",
    threadId: args.threadId,
  });
}

/**
 * Deletes leftover streamed pieces of finished items, a small batch at a time, for a short slice of each sweep
 * tick. The first run after startup queues every thread once: a thread with nothing to delete costs one indexed
 * lookup, and this is what cleans up Cloud threads from before their turns pruned.
 */
export async function runLeftoverStreamPiecePruneSweep(
  deps: Pick<AppDeps, "db" | "logger">,
): Promise<void> {
  const queue = leftoverStreamPieceQueue(deps.db);
  if (!queue.backlogQueued) {
    for (const thread of deps.db
      .select({ id: threads.id })
      .from(threads)
      .all()) {
      queue.threadIds.add(thread.id);
    }
    queue.backlogQueued = true;
  }

  const deadline = performance.now() + LEFTOVER_STREAM_PIECE_SWEEP_BUDGET_MS;
  while (performance.now() < deadline) {
    const [threadId] = queue.threadIds;
    if (threadId === undefined) {
      return;
    }
    const startedAt = performance.now();
    let removed: number;
    try {
      removed = runEventLoopWorkSync(
        "sweep:leftover-stream-pieces:advance",
        () =>
          pruneResolvedItemDeltas(deps.db, {
            limit: LEFTOVER_STREAM_PIECE_SWEEP_BATCH_SIZE,
            threadId,
          }),
      );
    } catch (error) {
      deps.logger.warn(
        { err: error, threadId },
        "Failed to prune leftover stream pieces",
      );
      // Try this thread again after the others, on a later tick.
      queue.threadIds.delete(threadId);
      queue.threadIds.add(threadId);
      return;
    }
    if (removed < LEFTOVER_STREAM_PIECE_SWEEP_BATCH_SIZE) {
      queue.threadIds.delete(threadId);
    }
    if (
      performance.now() - startedAt >=
      LEFTOVER_STREAM_PIECE_SWEEP_SLOW_STEP_MS
    ) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export function resetActiveThreadEventPruningState(threadId: string): void {
  activeThreadPruneStateByThreadId.delete(threadId);
}
