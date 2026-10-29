import { and, desc, eq, or, sql } from "drizzle-orm";
import {
  copyStoredThreadEventsInTransaction,
  createEventId,
  events,
  findLastCompletedRootStoredTurn,
  findLastRootStoredTurnStarted,
  listStoredEventRows,
  listStoredTurnCompletedRowsByTurnIds,
  type DbQueryConnection,
  type StoredEventRow,
} from "@cloudroom/db";
import {
  THREAD_CONTEXT_CLEAR_OPERATION,
  THREAD_HARNESS_SWITCH_OPERATION,
  THREAD_IMPORT_OPERATION,
  threadScope,
  type PromptInput,
  type Thread,
  type ThreadEvent,
  type ThreadEventType,
} from "@cloudroom/domain";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { parseStoredEvent } from "./thread-data.js";
import {
  appendThreadEventInTransaction,
  getLastProviderThreadId,
  parseStoredTurnRequestEvent,
} from "./thread-events.js";
import { resolveTurnProviderCheckpointId } from "./thread-edit-message.js";
import {
  threadForkDescriptorSchema,
  type ThreadForkDescriptor,
} from "./thread-startup-store.js";

export type ThreadForkHistory =
  | { kind: "thread"; sourceThreadId: string; endSequence: number }
  | { kind: "rows"; rows: StoredEventRow[] };

export interface ThreadForkPoint {
  descriptor: ThreadForkDescriptor;
  history: ThreadForkHistory | null;
}

function threadHistory(
  sourceThreadId: string,
  endSequence: number,
): ThreadForkHistory {
  return { kind: "thread", sourceThreadId, endSequence };
}

function forkPointUnavailable(message: string): never {
  throw new ApiError(400, "fork_source_session_unavailable", message);
}

interface StoredTurnCompletion {
  event: Extract<ThreadEvent, { type: "turn/completed" }>;
  sequence: number;
}

function readTurnCompletion(
  deps: Pick<AppDeps, "db">,
  args: { threadId: string; turnId: string },
): StoredTurnCompletion | null {
  const row = listStoredTurnCompletedRowsByTurnIds(deps.db, {
    threadId: args.threadId,
    turnIds: [args.turnId],
  }).at(-1);
  if (row === undefined) {
    return null;
  }
  const event = parseStoredEvent(row);
  if (event.type !== "turn/completed") {
    throw new Error(`Expected turn/completed event #${row.sequence}`);
  }
  return { event, sequence: row.sequence };
}

function resolveCheckpointForkDescriptor(args: {
  completion: StoredTurnCompletion;
  providerId: string;
  turnId: string;
}): ThreadForkDescriptor | null {
  if (args.completion.event.providerThreadId === null) {
    return null;
  }
  const sourceProviderCheckpointId = resolveTurnProviderCheckpointId({
    providerCheckpointId: args.completion.event.providerCheckpointId,
    providerId: args.providerId,
    turnId: args.turnId,
  });
  if (sourceProviderCheckpointId === null) {
    return null;
  }
  return {
    sourceProviderThreadId: args.completion.event.providerThreadId,
    sourceProviderCheckpointId,
  };
}

function resolveAnchoredForkPoint(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  args: { sourceSeqEnd: number; sourceThread: Thread },
): ThreadForkPoint {
  const anchor = findLastRootStoredTurnStarted(deps.db, {
    atOrBeforeSequence: args.sourceSeqEnd,
    threadId: args.sourceThread.id,
  });
  if (anchor === null) {
    forkPointUnavailable(
      `Cannot fork at sequence ${args.sourceSeqEnd}: no turn has started at or before it`,
    );
  }
  const completion = readTurnCompletion(deps, {
    threadId: args.sourceThread.id,
    turnId: anchor.turnId,
  });
  if (completion === null) {
    forkPointUnavailable(
      `Cannot fork at sequence ${args.sourceSeqEnd}: the turn containing it has not completed`,
    );
  }
  if (completion.event.providerThreadId === null) {
    forkPointUnavailable(
      `Cannot fork at sequence ${args.sourceSeqEnd}: the turn containing it has no provider session`,
    );
  }
  const latestRootTurn = findLastRootStoredTurnStarted(deps.db, {
    threadId: args.sourceThread.id,
  });
  const anchorIsTip = latestRootTurn?.turnId === anchor.turnId;
  if (
    !deps.providerRegistry.supportsSessionRewind(args.sourceThread.providerId)
  ) {
    if (!anchorIsTip) {
      forkPointUnavailable(
        `Provider ${args.sourceThread.providerId} can only fork at the end of a session, not from an earlier point in it`,
      );
    }
    return {
      descriptor: {
        sourceProviderThreadId: completion.event.providerThreadId,
      },
      history: threadHistory(args.sourceThread.id, completion.sequence),
    };
  }
  const descriptor = resolveCheckpointForkDescriptor({
    completion,
    providerId: args.sourceThread.providerId,
    turnId: anchor.turnId,
  });
  if (descriptor === null) {
    forkPointUnavailable(
      `Cannot fork at sequence ${args.sourceSeqEnd}: the turn containing it recorded no provider checkpoint`,
    );
  }
  return {
    descriptor,
    history: threadHistory(args.sourceThread.id, completion.sequence),
  };
}

export function resolveThreadForkPoint(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  args: { sourceSeqEnd: number | undefined; sourceThread: Thread },
): ThreadForkPoint | null {
  if (args.sourceSeqEnd !== undefined) {
    return resolveAnchoredForkPoint(deps, {
      sourceSeqEnd: args.sourceSeqEnd,
      sourceThread: args.sourceThread,
    });
  }
  const sourceProviderThreadId =
    getLastProviderThreadId(deps, args.sourceThread.id) ??
    pendingImportFork(deps.db, args.sourceThread.id)?.sourceProviderThreadId ??
    null;
  if (sourceProviderThreadId === null) {
    return null;
  }
  const lastCompletedTurn = findLastCompletedRootStoredTurn(deps.db, {
    threadId: args.sourceThread.id,
  });
  const tip: ThreadForkPoint = {
    descriptor: { sourceProviderThreadId },
    history:
      lastCompletedTurn === null
        ? null
        : threadHistory(args.sourceThread.id, lastCompletedTurn.completedSequence),
  };
  if (
    lastCompletedTurn === null ||
    !deps.providerRegistry.supportsSessionRewind(args.sourceThread.providerId)
  ) {
    return tip;
  }
  const latestRootTurn = findLastRootStoredTurnStarted(deps.db, {
    threadId: args.sourceThread.id,
  });
  if (latestRootTurn?.turnId === lastCompletedTurn.turnId) {
    return tip;
  }
  const completion = readTurnCompletion(deps, {
    threadId: args.sourceThread.id,
    turnId: lastCompletedTurn.turnId,
  });
  const descriptor =
    completion === null
      ? null
      : resolveCheckpointForkDescriptor({
          completion,
          providerId: args.sourceThread.providerId,
          turnId: lastCompletedTurn.turnId,
        });
  return descriptor === null ? tip : { ...tip, descriptor };
}

/**
 * The events that carry the conversation a fork inherits. Everything else the
 * source recorded is either the source's own bookkeeping (identity,
 * provisioning, usage snapshots, operations), streaming deltas the completed
 * items already fold in, or pending-interaction and goal state that belongs to
 * the source thread alone.
 */
export const INHERITED_EVENT_TYPES = [
  "client/turn/requested",
  "turn/started",
  "turn/input/accepted",
  "item/completed",
  "item/backgroundTask/completed",
  "turn/completed",
  "thread/compacted",
  "system/manager/user_message",
] as const satisfies readonly ThreadEventType[];

function parseAcceptedClientRequestId(row: StoredEventRow): string {
  const event = parseStoredEvent(row);
  if (event.type !== "turn/input/accepted") {
    throw new Error(`Expected turn/input/accepted event #${row.sequence}`);
  }
  return event.clientRequestId;
}

export function selectInheritedHistoryRows(
  rows: StoredEventRow[],
): StoredEventRow[] {
  const completedTurnIds = new Set<string>();
  const acceptedClientRequestIds = new Set<string>();
  for (const row of rows) {
    if (row.type === "turn/completed" && row.turnId !== null) {
      completedTurnIds.add(row.turnId);
    } else if (row.type === "turn/input/accepted") {
      acceptedClientRequestIds.add(parseAcceptedClientRequestId(row));
    }
  }
  return rows.filter((row) => {
    if (row.turnId !== null) {
      return completedTurnIds.has(row.turnId);
    }
    if (row.type !== "client/turn/requested") {
      return true;
    }
    return acceptedClientRequestIds.has(
      parseStoredTurnRequestEvent(row).requestId,
    );
  });
}

function listForkHistoryRows(
  deps: Pick<AppDeps, "db">,
  history: ThreadForkHistory,
): StoredEventRow[] {
  if (history.kind === "rows") {
    return history.rows;
  }
  return selectInheritedHistoryRows(
    listStoredEventRows(deps.db, {
      beforeSequence: history.endSequence + 1,
      threadId: history.sourceThreadId,
      types: INHERITED_EVENT_TYPES,
    }),
  );
}

export function copyForkSourceHistory(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    fork: Pick<Thread, "environmentId" | "id">;
    history: ThreadForkHistory;
  },
): void {
  const rows = listForkHistoryRows(deps, args.history).map((row) => ({
    ...row,
    providerThreadId: null,
  }));
  if (rows.length === 0) {
    return;
  }
  deps.db.transaction(
    (tx) =>
      copyStoredThreadEventsInTransaction(tx, {
        rows,
        targetEnvironmentId: args.fork.environmentId,
        targetThreadId: args.fork.id,
      }),
    { behavior: "immediate" },
  );
  deps.hub.notifyThread(args.fork.id, ["events-appended"], {
    eventTypes: [...new Set(rows.map((row) => row.type))],
  });
}

export function recordImportFork(
  deps: Pick<AppDeps, "db">,
  thread: Pick<Thread, "environmentId" | "id">,
  sourceProviderThreadId: string,
): void {
  deps.db.transaction(
    (tx) =>
      appendThreadEventInTransaction(tx, {
        threadId: thread.id,
        environmentId: thread.environmentId,
        type: "system/operation",
        scope: threadScope(),
        data: {
          operation: THREAD_IMPORT_OPERATION,
          operationId: createEventId(),
          status: "completed",
          message: `Imported from session ${sourceProviderThreadId}.`,
          metadata: { sourceProviderThreadId },
        },
      }),
    { behavior: "immediate" },
  );
}

export function recordTextImport(
  deps: Pick<AppDeps, "db">,
  thread: Pick<Thread, "environmentId" | "id">,
  seed: PromptInput[],
): void {
  deps.db.transaction(
    (tx) =>
      appendThreadEventInTransaction(tx, {
        threadId: thread.id,
        environmentId: thread.environmentId,
        type: "system/operation",
        scope: threadScope(),
        data: {
          operation: THREAD_IMPORT_OPERATION,
          operationId: createEventId(),
          status: "completed",
          message: "Imported as text.",
          metadata: { seed },
        },
      }),
    { behavior: "immediate" },
  );
}

export function pendingImportFork(
  db: DbQueryConnection,
  threadId: string,
): ThreadForkDescriptor | null {
  const row = db
    .select({ type: events.type, data: events.data })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        or(
          eq(events.type, "turn/started"),
          and(
            eq(events.type, "system/error"),
            sql`json_extract(${events.data}, '$.code') = 'thread_command_failed'`,
          ),
          and(
            eq(events.type, "system/operation"),
            sql`json_extract(${events.data}, '$.operation') IN (${THREAD_IMPORT_OPERATION}, ${THREAD_CONTEXT_CLEAR_OPERATION}, ${THREAD_HARNESS_SWITCH_OPERATION})`,
          ),
        ),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  if (row?.type !== "system/operation") return null;
  const data = JSON.parse(row.data) as {
    operation?: unknown;
    metadata?: unknown;
  };
  if (data.operation !== THREAD_IMPORT_OPERATION) return null;
  const fork = threadForkDescriptorSchema.safeParse(data.metadata);
  return fork.success ? fork.data : null;
}
