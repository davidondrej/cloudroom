import { and, desc, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  appendStoredThreadEventsInTransaction,
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
  turnScope,
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
import { messagesFromRows } from "./thread-transcript.js";

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

/** The provider session column is intentionally empty on inherited rows: Claude gives
 * the copied transcript new UUIDs. Only an original, completed root message can vouch for its ID. */
export function messageForkPoint(db: AppDeps["db"], source: Thread, sequence: number | undefined) {
  if (source.providerId !== "claude-code" || sequence === undefined) return null;
  const [row] = listStoredEventRows(db, {
    threadId: source.id, afterSequence: sequence - 1, beforeSequence: sequence + 1, types: ["item/completed"],
  });
  if (!row?.providerThreadId || !row.turnId || row.itemKind !== "agentMessage" || row.parentToolCallId) return null;
  const event = parseStoredEvent(row);
  if (event.type !== "item/completed" || event.item.type !== "agentMessage" || !event.item.providerCheckpointId) return null;
  const root = findLastRootStoredTurnStarted(db, { threadId: source.id, atOrBeforeSequence: sequence });
  if (root?.turnId !== row.turnId) return null;
  return { sourceProviderThreadId: row.providerThreadId, sourceProviderCheckpointId: event.item.providerCheckpointId };
}

/** Turn-only readers may use a finished turn for its last reply. A progress message
 * followed by more work would silently give the fork more than the user selected.
 * Trailing reasoning completions (flushed after the reply by older Cloud ACP/Pi turns)
 * aren't later work, so ignore them. */
export function checkTurnForkCutoff(
  db: AppDeps["db"], threadId: string, turnId: string, selected: number, completed: number,
): void {
  if (selected >= completed) return;
  const inTurn = and(eq(events.threadId, threadId), eq(events.turnId, turnId));
  const message = db.select({ id: events.id }).from(events).where(and(
    inTurn, eq(events.sequence, selected), eq(events.type, "item/completed"), eq(events.itemKind, "agentMessage"),
  )).get();
  if (!message) return;
  const later = db.select({ id: events.id }).from(events).where(and(
    inTurn, gt(events.sequence, selected), lt(events.sequence, completed),
    inArray(events.type, ["item/started", "item/completed", "turn/input/accepted", "item/backgroundTask/completed"]),
    or(ne(events.type, "item/completed"), isNull(events.itemKind), ne(events.itemKind, "reasoning")),
  )).limit(1).get();
  if (later) forkPointUnavailable("This message has no saved fork point. Choose a finished reply.");
}

function resolveAnchoredForkPoint(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  args: { sourceSeqEnd: number; sourceThread: Thread },
): ThreadForkPoint {
  const message = messageForkPoint(deps.db, args.sourceThread, args.sourceSeqEnd);
  if (message && deps.providerRegistry.supportsSessionRewind(args.sourceThread.providerId)) {
    return { descriptor: message, history: threadHistory(args.sourceThread.id, args.sourceSeqEnd) };
  }
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
  checkTurnForkCutoff(deps.db, args.sourceThread.id, anchor.turnId, args.sourceSeqEnd, completion.sequence);
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

/** A Local source's own session at that point, or null when its harness can't clone it there. The fork then copies
 *  the chat as text, so every harness can fork (ADR 20261121-141157). Waits for harnesses to register, so a fork right
 *  after launch doesn't miss a native one. */
export async function nativeForkPoint(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  args: { sourceSeqEnd: number | undefined; sourceThread: Thread },
): Promise<ThreadForkPoint | null> {
  await deps.providerRegistry.whenRegistrationsSettled();
  if (!deps.providerRegistry.supportsFork(args.sourceThread.providerId)) return null;
  try {
    return resolveThreadForkPoint(deps, args);
  } catch (error) {
    if (error instanceof ApiError && error.body.code === "fork_source_session_unavailable") return null;
    throw error;
  }
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
  partialTurnId?: string,
): StoredEventRow[] {
  const completedTurnIds = new Set<string>(partialTurnId ? [partialTurnId] : []);
  const acceptedClientRequestIds = new Set<string>();
  for (const row of rows) {
    if (row.type === "turn/completed" && row.turnId !== null) {
      completedTurnIds.add(row.turnId);
    }
  }
  for (const row of rows) {
    if (row.type === "turn/input/accepted" && row.turnId && completedTurnIds.has(row.turnId)) {
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
) {
  if (history.kind === "rows") {
    return { rows: history.rows, partial: undefined };
  }
  const rows = listStoredEventRows(deps.db, {
    beforeSequence: history.endSequence + 1,
    threadId: history.sourceThreadId,
    types: INHERITED_EVENT_TYPES,
  });
  const partial = partialForkReply(rows, history.endSequence);
  return { rows: selectInheritedHistoryRows(rows, partial?.turnId ?? undefined), partial };
}

function partialForkReply(rows: StoredEventRow[], endSequence: number) {
  const last = rows.at(-1);
  return last?.sequence === endSequence && last.type === "item/completed" && last.itemKind === "agentMessage"
    ? last : undefined;
}

export function textForkMessages(deps: Pick<AppDeps, "db">, threadId: string, endSequence: number, after: number) {
  // Keep the same accepted prompts as the visible fork, without loading tool output into the model seed.
  const rows = deps.db.select().from(events).where(and(
    eq(events.threadId, threadId), lte(events.sequence, endSequence), isNull(events.parentToolCallId),
    or(
      inArray(events.type, ["client/turn/requested", "turn/input/accepted", "turn/completed"]),
      and(eq(events.type, "item/completed"), or(eq(events.itemKind, "agentMessage"), isNull(events.itemKind))),
    ),
  )).orderBy(events.sequence).all();
  const partial = partialForkReply(rows, endSequence);
  const history = selectInheritedHistoryRows(rows, partial?.turnId ?? undefined);
  return messagesFromRows(history.filter(row => row.sequence > after &&
    (row.type === "client/turn/requested" || row.type === "item/completed")));
}

export function copyForkSourceHistory(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    fork: Pick<Thread, "environmentId" | "id">;
    history: ThreadForkHistory;
  },
): void {
  const { rows: sourceRows, partial } = listForkHistoryRows(deps, args.history);
  const rows = sourceRows.map((row) => ({
    ...row,
    providerThreadId: null,
  }));
  if (rows.length === 0) {
    return;
  }
  const eventTypes = new Set(rows.map((row) => row.type));
  deps.db.transaction(
    (tx) => {
      copyStoredThreadEventsInTransaction(tx, {
        rows,
        targetEnvironmentId: args.fork.environmentId,
        targetThreadId: args.fork.id,
      });
      if (partial?.turnId) {
        // The copied prefix is finished in the child, even while its source continues.
        appendStoredThreadEventsInTransaction(tx, [{
          threadId: args.fork.id,
          environmentId: args.fork.environmentId,
          createdAt: partial.createdAt,
          scope: turnScope(partial.turnId),
          type: "turn/completed",
          data: { status: "completed", providerThreadId: null },
        }]);
        eventTypes.add("turn/completed");
      }
    },
    { behavior: "immediate" },
  );
  deps.hub.notifyThread(args.fork.id, ["events-appended"], {
    eventTypes: [...eventTypes],
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
  carried?: true,
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
          metadata: { seed, ...(carried ? { carried } : {}) },
        },
      }),
    { behavior: "immediate" },
  );
}

export function pendingImportFork(
  db: DbQueryConnection,
  threadId: string,
): ThreadForkDescriptor | null {
  const fork = threadForkDescriptorSchema.safeParse(pendingImport(db, threadId)?.metadata);
  return fork.success ? fork.data : null;
}

/** An imported chat whose agent has not run yet; its next turn is its first. */
export function pendingImport(
  db: DbQueryConnection,
  threadId: string,
): { metadata?: unknown } | null {
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
  return data.operation === THREAD_IMPORT_OPERATION ? data : null;
}
