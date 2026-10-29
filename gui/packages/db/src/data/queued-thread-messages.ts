import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  min,
  notExists,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { QUEUED_MESSAGE_PLUGIN_WAIT_HOLDER_PREFIX } from "@cloudroom/domain";
import type {
  PermissionMode,
  PromptInput,
  QueuedMessagePayload,
  QueuedMessageSystemNotice,
  QueuedMessageWaitHolder,
  QueuedMessageWaitingOn,
  QueuedMessageWaitingOnKind,
} from "@cloudroom/domain";
import type {
  DbConnection,
  DbQueryConnection,
  DbTransaction,
} from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import {
  environments,
  events,
  queuedThreadMessages,
  threads,
} from "../schema.js";
import {
  createQueuedThreadMessageClaimToken,
  createQueuedThreadMessageId,
} from "../ids.js";
import { createOrderKeyAfter, createOrderKeyBetween } from "./order-keys.js";
import { queryInSqliteVariableBatches } from "./events.js";

export interface CreateQueuedThreadMessageInput {
  threadId: string;
  content: PromptInput[];
  senderThreadId?: string | null;
  model: string;
  reasoningLevel: string;
  permissionMode: PermissionMode;
  serviceTier: string;
  /**
   * Why the row is queued, written in the SAME insert rather than by a
   * follow-up update: a row that existed with no wait for even one statement
   * could be claimed by a concurrent drain, which is exactly the dispatch the
   * wait exists to prevent.
   */
  waitingOn: QueuedMessageWaitingOn | null;
  sendAt: number | null;
  payload: QueuedMessagePayload;
  /** Non-null only for one of core's own system notices. */
  systemNotice: QueuedMessageSystemNotice | null;
  hardQueue?: boolean;
}

export interface UpdateQueuedThreadMessageInput {
  content: PromptInput[];
  expectedUpdatedAt: number;
  id: string;
  threadId: string;
}

export type QueuedThreadMessageRow = typeof queuedThreadMessages.$inferSelect;

export interface ClaimedQueuedThreadMessageRow extends QueuedThreadMessageRow {
  claimedAt: number;
  claimToken: string;
}

export interface QueuedMessageThreadRow {
  oldestQueuedMessageCreatedAt: number | null;
  threadId: string;
}

export interface ReorderQueuedThreadMessageArgs {
  db: DbConnection;
  nextQueuedMessageId: string | null;
  notifier: DbNotifier;
  previousQueuedMessageId: string | null;
  queuedMessageId: string;
  threadId: string;
}

interface ResolveQueuedThreadMessageNeighborArgs {
  movedQueuedMessageId: string;
  neighborQueuedMessageId: string | null;
  threadId: string;
}

export interface ClaimedQueuedThreadMessageMutationArgs {
  claimToken: string;
  id: string;
}

export interface ReleaseStaleQueuedMessageClaimsArgs {
  claimedBefore: number;
  protectedClaimTokens: readonly string[];
}

export interface ReorderQueuedThreadMessageSuccess {
  kind: "reordered";
  queuedMessages: QueuedThreadMessageRow[];
}

export interface ReorderQueuedThreadMessageUnchanged {
  kind: "unchanged";
  queuedMessages: QueuedThreadMessageRow[];
}

export interface ReorderQueuedThreadMessageNotFound {
  kind: "not_found";
}

export interface ReorderQueuedThreadMessageClaimed {
  kind: "claimed";
}

export interface ReorderQueuedThreadMessageStaleNeighbor {
  kind: "stale_neighbor";
}

export interface ReorderQueuedThreadMessageInvalidNeighborOrder {
  kind: "invalid_neighbor_order";
}

export type ReorderQueuedThreadMessageResult =
  | ReorderQueuedThreadMessageSuccess
  | ReorderQueuedThreadMessageUnchanged
  | ReorderQueuedThreadMessageNotFound
  | ReorderQueuedThreadMessageClaimed
  | ReorderQueuedThreadMessageStaleNeighbor
  | ReorderQueuedThreadMessageInvalidNeighborOrder;

export type UpdateQueuedThreadMessageResult =
  | { kind: "updated"; queuedMessage: QueuedThreadMessageRow }
  | { kind: "not_found" }
  | { kind: "claimed" }
  | { kind: "stale" };

export type ReleaseQueuedMessageClaimArgs =
  ClaimedQueuedThreadMessageMutationArgs;

/**
 * The waits that mean "this row is only behind the turn that is running". The
 * manual-stop queue pause exists to hold exactly these back, because a user
 * who stopped a thread did not thereby ask for whatever was lined up behind
 * it.
 */
const ORDINARY_TURN_END_WAIT_KINDS = ["thread-busy", "turn-starting"] as const;

/**
 * Every wait an idle thread clears by being idle. `stopping` joins the
 * ordinary two rather than replacing them: it is drainable for the same
 * reason, and deliberately outside {@link ORDINARY_TURN_END_WAIT_KINDS} so the
 * manual-stop pause lets it through — a row acquires it only from an action
 * the user took after requesting the stop.
 */
const IDLE_DRAINABLE_WAIT_KINDS = [
  ...ORDINARY_TURN_END_WAIT_KINDS,
  "stopping",
] as const;

function hasOrdinaryTurnEndWait(row: QueuedThreadMessageRow): boolean {
  if (row.waitingOn === null) return true;
  try {
    const parsed = JSON.parse(row.waitingOn) as { kind?: unknown };
    return ORDINARY_TURN_END_WAIT_KINDS.some(
      (waitKind) => waitKind === parsed.kind,
    );
  } catch {
    return false;
  }
}

export function isOrdinaryTurnEndQueuedMessage(
  row: QueuedThreadMessageRow,
): boolean {
  return row.systemNotice === null && hasOrdinaryTurnEndWait(row);
}

/**
 * The JS mirror of {@link drainableQueuedThreadMessage}'s wait condition, for
 * deciding eligibility over rows already in hand. Kept next to a
 * pointer at the SQL so the two cannot drift silently.
 */
function isIdleDrainableQueuedMessage(row: QueuedThreadMessageRow): boolean {
  if (row.failureReason !== null) return false;
  if (row.waitingOn === null) return true;
  try {
    const parsed = JSON.parse(row.waitingOn) as { kind?: unknown };
    return IDLE_DRAINABLE_WAIT_KINDS.some(
      (waitKind) => waitKind === parsed.kind,
    );
  } catch {
    return false;
  }
}

function isQueuedThreadMessageClaimed(row: QueuedThreadMessageRow): boolean {
  return row.claimedAt !== null || row.claimToken !== null;
}

function requireClaimedQueuedThreadMessage(
  row: QueuedThreadMessageRow | null,
): ClaimedQueuedThreadMessageRow | null {
  if (!row || row.claimedAt === null || row.claimToken === null) {
    return null;
  }
  return {
    ...row,
    claimedAt: row.claimedAt,
    claimToken: row.claimToken,
  };
}

export function listQueuedThreadMessages(
  db: DbQueryConnection,
  threadId: string,
): QueuedThreadMessageRow[] {
  return db
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        eq(queuedThreadMessages.threadId, threadId),
        isNull(queuedThreadMessages.claimedAt),
        isNull(queuedThreadMessages.claimToken),
      ),
    )
    .orderBy(asc(queuedThreadMessages.sortKey), asc(queuedThreadMessages.id))
    .all();
}

function getLastQueuedThreadMessage(
  db: DbQueryConnection,
  threadId: string,
): QueuedThreadMessageRow | null {
  return (
    db
      .select()
      .from(queuedThreadMessages)
      .where(eq(queuedThreadMessages.threadId, threadId))
      .orderBy(
        desc(queuedThreadMessages.sortKey),
        desc(queuedThreadMessages.id),
      )
      .limit(1)
      .get() ?? null
  );
}

function resolveQueuedThreadMessageNeighbor(
  db: DbQueryConnection,
  args: ResolveQueuedThreadMessageNeighborArgs,
): QueuedThreadMessageRow | null | false {
  if (args.neighborQueuedMessageId === null) {
    return null;
  }
  if (args.neighborQueuedMessageId === args.movedQueuedMessageId) {
    return false;
  }

  const neighbor = getQueuedThreadMessage(
    db,
    args.neighborQueuedMessageId,
  );
  if (
    !neighbor ||
    neighbor.threadId !== args.threadId ||
    isQueuedThreadMessageClaimed(neighbor)
  ) {
    return false;
  }
  return neighbor;
}

export function createQueuedThreadMessageInTransaction(
  tx: DbTransaction,
  input: CreateQueuedThreadMessageInput,
) {
  const now = Date.now();
  const id = createQueuedThreadMessageId();
  const lastQueuedMessage = getLastQueuedThreadMessage(tx, input.threadId);
  const sortKey = lastQueuedMessage
    ? createOrderKeyAfter({ previousKey: lastQueuedMessage.sortKey })
    : createOrderKeyBetween({ previousKey: null, nextKey: null });
  return tx
    .insert(queuedThreadMessages)
    .values({
      id,
      threadId: input.threadId,
      content: JSON.stringify(input.content),
      senderThreadId: input.senderThreadId ?? null,
      model: input.model,
      reasoningLevel: input.reasoningLevel,
      permissionMode: input.permissionMode,
      serviceTier: input.serviceTier,
      waitingOn:
        input.waitingOn === null ? null : JSON.stringify(input.waitingOn),
      waitHolder:
        input.waitingOn === null ? null : waitHolderFor(input.waitingOn),
      sendAt: input.sendAt,
      systemNotice:
        input.systemNotice === null ? null : JSON.stringify(input.systemNotice),
      payloadKind: input.payload.kind,
      retryOfTurnRequestId:
        input.payload.kind === "retry"
          ? input.payload.retryOfTurnRequestId
          : null,
      retryAttempt:
        input.payload.kind === "retry" ? input.payload.attempt : null,
      retryReason: input.payload.kind === "retry" ? input.payload.reason : null,
      hardQueue: input.hardQueue ?? false,
      claimedAt: null,
      claimToken: null,
      sortKey,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function createQueuedThreadMessage(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateQueuedThreadMessageInput,
) {
  const row = db.transaction(
    (tx) => createQueuedThreadMessageInTransaction(tx, input),
    { behavior: "immediate" },
  );
  notifier.notifyThread(input.threadId, ["queue-changed"]);
  return row;
}

export function updateQueuedThreadMessage(
  db: DbConnection,
  notifier: DbNotifier,
  input: UpdateQueuedThreadMessageInput,
): UpdateQueuedThreadMessageResult {
  const result = db.transaction(
    (tx): UpdateQueuedThreadMessageResult => {
      const existing = getQueuedThreadMessage(tx, input.id);
      if (!existing || existing.threadId !== input.threadId) {
        return { kind: "not_found" };
      }
      if (isQueuedThreadMessageClaimed(existing)) {
        return { kind: "claimed" };
      }
      if (existing.updatedAt !== input.expectedUpdatedAt) {
        return { kind: "stale" };
      }

      const queuedMessage = tx
        .update(queuedThreadMessages)
        .set({
          content: JSON.stringify(input.content),
          updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
        })
        .where(eq(queuedThreadMessages.id, input.id))
        .returning()
        .get();
      if (!queuedMessage) {
        return { kind: "not_found" };
      }
      return { kind: "updated", queuedMessage };
    },
    { behavior: "immediate" },
  );

  if (result.kind === "updated") {
    notifier.notifyThread(input.threadId, ["queue-changed"]);
  }
  return result;
}

export function getQueuedThreadMessage(db: DbQueryConnection, id: string) {
  return (
    db
      .select()
      .from(queuedThreadMessages)
      .where(eq(queuedThreadMessages.id, id))
      .get() ?? null
  );
}

export function hasQueuedThreadMessages(
  db: DbQueryConnection,
  threadId: string,
): boolean {
  return (
    db
      .select({ id: queuedThreadMessages.id })
      .from(queuedThreadMessages)
      .where(eq(queuedThreadMessages.threadId, threadId))
      .limit(1)
      .get() !== undefined
  );
}

function manuallyStoppedQueuePauseQuery(
  db: DbQueryConnection,
  threadId: string | typeof threads.id,
) {
  const interruption = alias(events, "queue_pause_interruption");
  const laterInterruption = alias(events, "queue_pause_later_interruption");
  const laterRootTurnStart = alias(events, "queue_pause_later_turn_start");
  const laterTurnRequest = alias(events, "queue_pause_later_turn_request");
  return db
    .select({ sequence: interruption.sequence })
    .from(interruption)
    .where(
      and(
        sql`${interruption.threadId} = ${threadId}`,
        eq(interruption.type, "system/thread/interrupted"),
        sql`json_extract(${interruption.data}, '$.reason') = 'manual-stop'`,
        notExists(
          db
            .select({ sequence: laterInterruption.sequence })
            .from(laterInterruption)
            .where(
              and(
                eq(laterInterruption.threadId, interruption.threadId),
                eq(laterInterruption.type, "system/thread/interrupted"),
                sql`${laterInterruption.sequence} > ${interruption.sequence}`,
              ),
            ),
        ),
        notExists(
          db
            .select({ sequence: laterRootTurnStart.sequence })
            .from(laterRootTurnStart)
            .where(
              and(
                eq(laterRootTurnStart.threadId, interruption.threadId),
                eq(laterRootTurnStart.type, "turn/started"),
                isNull(laterRootTurnStart.parentToolCallId),
                sql`${laterRootTurnStart.sequence} > ${interruption.sequence}`,
                exists(
                  db
                    .select({ sequence: laterTurnRequest.sequence })
                    .from(laterTurnRequest)
                    .where(
                      and(
                        eq(laterTurnRequest.threadId, interruption.threadId),
                        eq(laterTurnRequest.type, "client/turn/requested"),
                        sql`${laterTurnRequest.sequence} > ${interruption.sequence}`,
                        sql`${laterTurnRequest.sequence} < ${laterRootTurnStart.sequence}`,
                      ),
                    ),
                ),
              ),
            ),
        ),
      ),
    )
    .limit(1);
}

export function isThreadQueueAutoSendPaused(
  db: DbQueryConnection,
  threadId: string,
): boolean {
  return manuallyStoppedQueuePauseQuery(db, threadId).get() !== undefined;
}

/**
 * The SQL mirror of {@link isOrdinaryTurnEndQueuedMessage}, negated: the rows
 * the manual-stop queue pause does not apply to. Kept beside the JS predicate
 * it mirrors so the two cannot drift silently.
 */
function notOrdinaryTurnEndQueuedThreadMessage() {
  return or(
    isNotNull(queuedThreadMessages.systemNotice),
    and(
      isNotNull(queuedThreadMessages.waitingOn),
      notInArray(
        sql<string>`json_extract(${queuedThreadMessages.waitingOn}, '$.kind')`,
        [...ORDINARY_TURN_END_WAIT_KINDS],
      ),
    ),
  );
}

/**
 * Threads a drain could move right now.
 *
 * `pending` is included alongside `idle`, and the environment join is a LEFT
 * join because of it: a `pending` thread has never provisioned, so it has no
 * environment row to join to, and an inner join silently dropped exactly the
 * threads whose first message is waiting to start them.
 */
export function listIdleThreadsWithQueuedMessages(
  db: DbConnection,
): QueuedMessageThreadRow[] {
  return db
    .select({
      threadId: threads.id,
      oldestQueuedMessageCreatedAt: min(queuedThreadMessages.createdAt),
    })
    .from(queuedThreadMessages)
    .innerJoin(threads, eq(threads.id, queuedThreadMessages.threadId))
    .leftJoin(environments, eq(environments.id, threads.environmentId))
    .where(
      and(
        inArray(threads.status, ["idle", "pending"]),
        isNull(threads.archivedAt),
        isNull(threads.deletedAt),
        or(
          notExists(manuallyStoppedQueuePauseQuery(db, threads.id)),
          notOrdinaryTurnEndQueuedThreadMessage(),
        ),
        or(
          isNull(threads.environmentId),
          ne(environments.status, "destroyed"),
        ),
        // Only rows an idle thread actually unblocks. A thread whose only
        // queued row is waiting on a clock or a plugin is not a drain
        // candidate, and listing it would re-run the whole send pipeline
        // every sweep tick for a row that cannot move.
        drainableQueuedThreadMessage(),
      ),
    )
    .groupBy(threads.id)
    .orderBy(asc(min(queuedThreadMessages.createdAt)), asc(threads.id))
    .all();
}

function claimQueuedThreadMessageInTransaction(
  tx: DbTransaction,
  id: string,
): ClaimedQueuedThreadMessageRow | null {
  const now = Date.now();
  const updated = tx
    .update(queuedThreadMessages)
    .set({
      claimedAt: now,
      claimToken: createQueuedThreadMessageClaimToken(),
      updatedAt: now,
    })
    .where(
      and(
        eq(queuedThreadMessages.id, id),
        isNull(queuedThreadMessages.claimedAt),
        isNull(queuedThreadMessages.claimToken),
      ),
    )
    .returning()
    .get();
  return requireClaimedQueuedThreadMessage(updated ?? null);
}

export type QueuedThreadMessageEligibility = (
  row: QueuedThreadMessageRow,
) => boolean;

export type QueuedThreadMessageClaimPolicy =
  | {
      kind: "automatic";
      isEligible: QueuedThreadMessageEligibility;
    }
  | { kind: "explicit-send" };

function isAutomaticQueuedThreadMessageClaimAllowed(
  row: QueuedThreadMessageRow,
  pauseOrdinaryMessages: boolean,
): boolean {
  return (
    row.failureReason === null &&
    (!pauseOrdinaryMessages || !isOrdinaryTurnEndQueuedMessage(row))
  );
}

export function claimQueuedThreadMessage(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  policy: QueuedThreadMessageClaimPolicy = { kind: "explicit-send" },
): ClaimedQueuedThreadMessageRow | null {
  const claimedQueuedMessage = db.transaction(
    (tx) => {
      const existing = getQueuedThreadMessage(tx, id);
      if (!existing || isQueuedThreadMessageClaimed(existing)) {
        return null;
      }
      if (
        policy.kind === "automatic" &&
        (!isAutomaticQueuedThreadMessageClaimAllowed(
          existing,
          isThreadQueueAutoSendPaused(tx, existing.threadId),
        ) ||
          !policy.isEligible(existing))
      ) {
        return null;
      }
      return claimQueuedThreadMessageInTransaction(tx, id);
    },
    { behavior: "immediate" },
  );

  if (claimedQueuedMessage) {
    notifier.notifyThread(claimedQueuedMessage.threadId, ["queue-changed"]);
  }
  return claimedQueuedMessage;
}

export function claimNextQueuedThreadMessage(
  db: DbConnection,
  notifier: DbNotifier,
  threadId: string,
  isEligible?: QueuedThreadMessageEligibility,
): ClaimedQueuedThreadMessageRow | null {
  const claimedQueuedMessage = db.transaction(
    (tx) => {
      const pauseOrdinaryMessages = isThreadQueueAutoSendPaused(tx, threadId);
      const next = listQueuedThreadMessages(tx, threadId).find(
        (row) =>
          isIdleDrainableQueuedMessage(row) &&
          (isEligible?.(row) ?? true) &&
          isAutomaticQueuedThreadMessageClaimAllowed(row, pauseOrdinaryMessages),
      );
      return next ? claimQueuedThreadMessageInTransaction(tx, next.id) : null;
    },
    { behavior: "immediate" },
  );

  if (claimedQueuedMessage) {
    notifier.notifyThread(threadId, ["queue-changed"]);
  }
  return claimedQueuedMessage;
}

export function reorderQueuedThreadMessage({
  db,
  nextQueuedMessageId,
  notifier,
  previousQueuedMessageId,
  queuedMessageId,
  threadId,
}: ReorderQueuedThreadMessageArgs): ReorderQueuedThreadMessageResult {
  const result = db.transaction(
    (tx): ReorderQueuedThreadMessageResult => {
      const movedQueuedMessage = getQueuedThreadMessage(tx, queuedMessageId);
      if (!movedQueuedMessage || movedQueuedMessage.threadId !== threadId) {
        return { kind: "not_found" };
      }
      if (isQueuedThreadMessageClaimed(movedQueuedMessage)) {
        return { kind: "claimed" };
      }

      const previousQueuedMessage = resolveQueuedThreadMessageNeighbor(tx, {
        movedQueuedMessageId: queuedMessageId,
        neighborQueuedMessageId: previousQueuedMessageId,
        threadId,
      });
      const nextQueuedMessage = resolveQueuedThreadMessageNeighbor(tx, {
        movedQueuedMessageId: queuedMessageId,
        neighborQueuedMessageId: nextQueuedMessageId,
        threadId,
      });
      if (previousQueuedMessage === false || nextQueuedMessage === false) {
        return { kind: "stale_neighbor" };
      }
      if (
        previousQueuedMessage !== null &&
        nextQueuedMessage !== null &&
        previousQueuedMessage.sortKey >= nextQueuedMessage.sortKey
      ) {
        return { kind: "invalid_neighbor_order" };
      }

      const currentQueuedMessages = listQueuedThreadMessages(tx, threadId);
      const currentIndex = currentQueuedMessages.findIndex(
        (queuedMessage) => queuedMessage.id === queuedMessageId,
      );
      const currentPreviousQueuedMessageId =
        currentQueuedMessages[currentIndex - 1]?.id ?? null;
      const currentNextQueuedMessageId =
        currentQueuedMessages[currentIndex + 1]?.id ?? null;
      if (
        currentPreviousQueuedMessageId === previousQueuedMessageId &&
        currentNextQueuedMessageId === nextQueuedMessageId
      ) {
        return {
          kind: "unchanged",
          queuedMessages: currentQueuedMessages,
        };
      }

      const sortKey = createOrderKeyBetween({
        previousKey: previousQueuedMessage?.sortKey ?? null,
        nextKey: nextQueuedMessage?.sortKey ?? null,
      });
      const updated = tx
        .update(queuedThreadMessages)
        .set({ sortKey, updatedAt: Date.now() })
        .where(
          and(
            eq(queuedThreadMessages.id, queuedMessageId),
            isNull(queuedThreadMessages.claimedAt),
            isNull(queuedThreadMessages.claimToken),
          ),
        )
        .returning({ id: queuedThreadMessages.id })
        .get();
      if (!updated) {
        return { kind: "stale_neighbor" };
      }

      return {
        kind: "reordered",
        queuedMessages: listQueuedThreadMessages(tx, threadId),
      };
    },
    { behavior: "immediate" },
  );

  if (result.kind === "reordered") {
    notifier.notifyThread(threadId, ["queue-changed"]);
  }
  return result;
}

export interface RequeueClaimedQueuedThreadMessageArgs {
  claim: ClaimedQueuedThreadMessageMutationArgs;
  threadId: string;
  waitingOn: QueuedMessageWaitingOn;
  sendAt: number | null;
}

export function requeueClaimedQueuedThreadMessage(
  db: DbQueryConnection,
  notifier: DbNotifier,
  args: RequeueClaimedQueuedThreadMessageArgs,
): QueuedThreadMessageRow | null {
  const queued = db.transaction(
    (tx) => {
      const now = Date.now();
      tx.update(queuedThreadMessages)
        .set({ claimedAt: null, claimToken: null, updatedAt: now })
        .where(
          and(
            eq(queuedThreadMessages.id, args.claim.id),
            eq(queuedThreadMessages.claimToken, args.claim.claimToken),
          ),
        )
        .run();
      return (
        tx
          .update(queuedThreadMessages)
          .set({
            waitingOn: JSON.stringify(args.waitingOn),
            waitHolder: waitHolderFor(args.waitingOn),
            sendAt: args.sendAt,
            // A re-queue is a fresh, successful statement of why this row is
            // waiting, which supersedes whatever the previous attempt failed
            // with. Leaving a stale failure next to a current wait would show
            // the user two contradictory explanations of the same row.
            failureReason: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(queuedThreadMessages.id, args.claim.id),
              eq(queuedThreadMessages.threadId, args.threadId),
              liveQueuedThreadMessage(),
            ),
          )
          .returning()
          .get() ?? null
      );
    },
    { behavior: "immediate" },
  );
  if (queued) {
    notifier.notifyThread(args.threadId, ["queue-changed"]);
  }
  return queued;
}

export function releaseQueuedMessageClaim(
  db: DbConnection,
  notifier: DbNotifier,
  args: ReleaseQueuedMessageClaimArgs,
): boolean {
  const existing = db
    .select()
    .from(queuedThreadMessages)
    .where(eq(queuedThreadMessages.id, args.id))
    .get();
  if (
    !existing ||
    existing.claimedAt === null ||
    existing.claimToken !== args.claimToken
  ) {
    return false;
  }

  const now = Date.now();
  const result = db
    .update(queuedThreadMessages)
    .set({ claimedAt: null, claimToken: null, updatedAt: now })
    .where(
      and(
        eq(queuedThreadMessages.id, args.id),
        isNotNull(queuedThreadMessages.claimedAt),
        eq(queuedThreadMessages.claimToken, args.claimToken),
      ),
    )
    .run();
  if (result.changes === 0) {
    return false;
  }

  notifier.notifyThread(existing.threadId, ["queue-changed"]);
  return true;
}

export function releaseStaleQueuedMessageClaims(
  db: DbConnection,
  notifier: DbNotifier,
  args: ReleaseStaleQueuedMessageClaimsArgs,
): number {
  const protectedClaimTokens = [...args.protectedClaimTokens];
  const staleClaimWhere = and(
    isNotNull(queuedThreadMessages.claimedAt),
    lt(queuedThreadMessages.claimedAt, args.claimedBefore),
    ...(protectedClaimTokens.length > 0
      ? [
          or(
            isNull(queuedThreadMessages.claimToken),
            notInArray(queuedThreadMessages.claimToken, protectedClaimTokens),
          )!,
        ]
      : []),
  );
  const staleRows = db
    .select({
      id: queuedThreadMessages.id,
      threadId: queuedThreadMessages.threadId,
    })
    .from(queuedThreadMessages)
    .where(staleClaimWhere)
    .all();
  if (staleRows.length === 0) {
    return 0;
  }

  const now = Date.now();
  const result = db
    .update(queuedThreadMessages)
    .set({ claimedAt: null, claimToken: null, updatedAt: now })
    .where(staleClaimWhere)
    .run();

  for (const threadId of new Set(staleRows.map((row) => row.threadId))) {
    notifier.notifyThread(threadId, ["queue-changed"]);
  }

  return result.changes;
}

export function deleteClaimedQueuedThreadMessageInTransaction(
  db: DbTransaction,
  claim: ClaimedQueuedThreadMessageMutationArgs,
): boolean {
  const deleted = db
    .delete(queuedThreadMessages)
    .where(
      and(
        eq(queuedThreadMessages.id, claim.id),
        eq(queuedThreadMessages.claimToken, claim.claimToken),
      ),
    )
    .returning({ id: queuedThreadMessages.id })
    .get();
  return deleted !== undefined;
}

/**
 * A row is live while no drain worker holds it. Queueing, re-queueing and
 * clearing a wait are all lost updates against a row that is already being
 * dispatched, so every wait mutation is gated on liveness in the same
 * statement that performs it.
 */
function liveQueuedThreadMessage() {
  return and(
    isNull(queuedThreadMessages.claimedAt),
    isNull(queuedThreadMessages.claimToken),
  );
}

function automaticallyDrainableQueuedThreadMessage() {
  return and(
    liveQueuedThreadMessage(),
    isNull(queuedThreadMessages.failureReason),
  );
}

/**
 * Rows the IDLE drain may claim: a row with no wait at all, or one waiting
 * on the thread being busy or its turn starting — waits an idle thread
 * clears.
 *
 * Every other wait belongs to a different drain and must be invisible here, or
 * the idle sweep would dispatch a message scheduled for 9am the moment the
 * thread went quiet. That is also why an ineligible row does not BLOCK the
 * ones behind it: the queue is a queue, not a pipeline, so a row queued
 * on a plugin for an hour is overtaken by the follow-up the user sent after
 * it rather than stalling the whole thread. Plain queued rows are all
 * `thread-busy`, so among themselves they keep strict FIFO order, which is
 * what makes today's queue behaviour unchanged.
 */
function drainableQueuedThreadMessage() {
  return and(
    automaticallyDrainableQueuedThreadMessage(),
    or(
      isNull(queuedThreadMessages.waitingOn),
      inArray(
        sql<string>`json_extract(${queuedThreadMessages.waitingOn}, '$.kind')`,
        [...IDLE_DRAINABLE_WAIT_KINDS],
      ),
    ),
  );
}

export interface ListQueuedThreadMessagesForApiArgs {
  threadId?: string;
  waitHolder?: QueuedMessageWaitHolder;
}

/**
 * The cross-thread queued-row list behind `GET /queued-messages`. Both filters
 * are genuinely absent by default: unfiltered means every live row in the
 * workspace, which is what a whole-workspace pending view asks for.
 */
export function listQueuedThreadMessagesForApi(
  db: DbQueryConnection,
  args: ListQueuedThreadMessagesForApiArgs,
): QueuedThreadMessageRow[] {
  return db
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        liveQueuedThreadMessage(),
        ...(args.threadId === undefined
          ? []
          : [eq(queuedThreadMessages.threadId, args.threadId)]),
        ...(args.waitHolder === undefined
          ? []
          : [eq(queuedThreadMessages.waitHolder, args.waitHolder)]),
      ),
    )
    .orderBy(asc(queuedThreadMessages.createdAt), asc(queuedThreadMessages.id))
    .all();
}

export interface QueuedThreadMessageCounts {
  threadId: string;
  queuedMessageCount: number;
  /**
   * How many of those rows last failed to dispatch. Counted in the same pass
   * as the total because both answers come from the same rows, and the thread
   * list needs them together: a thread with queued work shows a clock, and one
   * whose queued work failed shows the failure instead.
   */
  failedQueuedMessageCount: number;
}

/**
 * How many live rows each of these threads has queued, and how many of those
 * failed. One grouped query rather than one per thread: the thread list renders
 * a glyph per row and would otherwise issue a query per visible thread.
 *
 * Batched over the SQLite variable limit because the thread list is unbounded —
 * a workspace with tens of thousands of threads builds its sidebar from one
 * call.
 */
export function listQueuedThreadMessageCountsByThreadIds(
  db: DbQueryConnection,
  args: { threadIds: readonly string[] },
): QueuedThreadMessageCounts[] {
  return queryInSqliteVariableBatches({
    dedupeKey: (threadId) => threadId,
    fixedVariableCount: 0,
    variableCountPerValue: 1,
    values: args.threadIds,
    queryBatch: (threadIds) =>
      db
        .select({
          threadId: queuedThreadMessages.threadId,
          queuedMessageCount: count(queuedThreadMessages.id),
          failedQueuedMessageCount: count(queuedThreadMessages.failureReason),
        })
        .from(queuedThreadMessages)
        .where(
          and(
            inArray(queuedThreadMessages.threadId, [...threadIds]),
            liveQueuedThreadMessage(),
          ),
        )
        .groupBy(queuedThreadMessages.threadId)
        .all(),
  });
}

/**
 * The single place `wait_holder` is derived from `waiting_on`. Keeping it here
 * — rather than letting callers pass a holder — is what makes the
 * denormalization safe: the two columns are always written together, from the
 * same value.
 */
function waitHolderFor(
  waitingOn: QueuedMessageWaitingOn,
): QueuedMessageWaitHolder | null {
  return waitingOn.kind === "plugin"
    ? `${QUEUED_MESSAGE_PLUGIN_WAIT_HOLDER_PREFIX}${waitingOn.pluginId}`
    : null;
}

export interface SetQueuedThreadMessageWaitingOnArgs {
  id: string;
  threadId: string;
  waitingOn: QueuedMessageWaitingOn;
  /**
   * The row's scheduled instant. Passed on every call rather than left alone,
   * because a re-queue is a fresh statement of when this row may run: a
   * `time` wait sets it, and every other wait kind clears it by passing null.
   */
  sendAt: number | null;
}

export interface ClearQueuedThreadMessageWaitingOnArgs {
  id: string;
  threadId: string;
}

export interface ListQueuedThreadMessagesWaitingOnKindArgs {
  kind: QueuedMessageWaitingOnKind;
  threadId: string;
}

/**
 * Queue a live row on a typed wait. Returns the updated row, or null when the
 * row is gone, belongs to another thread, or has already been claimed.
 */
export function setQueuedThreadMessageWaitingOn(
  db: DbConnection,
  notifier: DbNotifier,
  args: SetQueuedThreadMessageWaitingOnArgs,
): QueuedThreadMessageRow | null {
  const updated =
    db
      .update(queuedThreadMessages)
      .set({
        waitingOn: JSON.stringify(args.waitingOn),
        waitHolder: waitHolderFor(args.waitingOn),
        sendAt: args.sendAt,
        // Same rule as `requeueClaimedQueuedThreadMessage`: any fresh,
        // successful statement of why this row is waiting supersedes whatever
        // a previous attempt failed with. Leaving a stale failure beside a
        // current wait would show the reader two contradictory explanations of
        // one row.
        failureReason: null,
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(queuedThreadMessages.id, args.id),
          eq(queuedThreadMessages.threadId, args.threadId),
          liveQueuedThreadMessage(),
        ),
      )
      .returning()
      .get() ?? null;

  if (updated) {
    notifier.notifyThread(args.threadId, ["queue-changed"]);
  }
  return updated;
}

export interface SetQueuedThreadMessageFailureReasonArgs {
  id: string;
  threadId: string;
  failureReason: string;
}

/**
 * Records why a drain attempt on this row failed outright.
 *
 * Only the drain writes this: an inline attempt has a caller still listening
 * and reports to them instead. The row's wait is deliberately untouched — it
 * is still waiting on whatever it was waiting on, and the failure is a separate
 * fact about the last attempt rather than a new reason to wait. A later
 * successful re-queue clears it (see `requeueClaimedQueuedThreadMessage`).
 */
export function setQueuedThreadMessageFailureReason(
  db: DbConnection,
  notifier: DbNotifier,
  args: SetQueuedThreadMessageFailureReasonArgs,
): QueuedThreadMessageRow | null {
  const updated =
    db
      .update(queuedThreadMessages)
      .set({
        failureReason: args.failureReason,
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(queuedThreadMessages.id, args.id),
          eq(queuedThreadMessages.threadId, args.threadId),
          liveQueuedThreadMessage(),
        ),
      )
      .returning()
      .get() ?? null;

  if (updated) {
    notifier.notifyThread(args.threadId, ["queue-changed"]);
  }
  return updated;
}

/**
 * Drop a live row's wait, leaving it an ordinary queued row eligible at the
 * next drain. `sendAt` is cleared with it: a row with no wait is not waiting
 * for a clock either.
 */
export function clearQueuedThreadMessageWaitingOn(
  db: DbConnection,
  notifier: DbNotifier,
  args: ClearQueuedThreadMessageWaitingOnArgs,
): QueuedThreadMessageRow | null {
  const updated =
    db
      .update(queuedThreadMessages)
      .set({
        waitingOn: null,
        waitHolder: null,
        sendAt: null,
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(queuedThreadMessages.id, args.id),
          eq(queuedThreadMessages.threadId, args.threadId),
          liveQueuedThreadMessage(),
        ),
      )
      .returning()
      .get() ?? null;

  if (updated) {
    notifier.notifyThread(args.threadId, ["queue-changed"]);
  }
  return updated;
}

/**
 * Rows whose scheduled instant has arrived and that a drain may act on now,
 * oldest-due first. Threads that are archived or deleted are excluded here
 * rather than by the caller, so a scheduled send into a thread the user threw
 * away never wakes the sweep every cycle (the #1789 shape).
 *
 * The thread check is a correlated EXISTS rather than a join on purpose. A
 * join lets SQLite drive from `threads` — scanning every live thread to find
 * the few with a due row — which throws away the partial due index entirely.
 * EXISTS forces the queue table to be the outer loop, so the sweep costs one
 * index range scan plus a primary-key probe per hit.
 */
export function listDueScheduledQueuedThreadMessages(
  db: DbQueryConnection,
  now: number,
): QueuedThreadMessageRow[] {
  return db
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        isNotNull(queuedThreadMessages.sendAt),
        lte(queuedThreadMessages.sendAt, now),
        automaticallyDrainableQueuedThreadMessage(),
        exists(
          db
            .select({ live: sql`1` })
            .from(threads)
            .where(
              and(
                eq(threads.id, queuedThreadMessages.threadId),
                isNull(threads.archivedAt),
                isNull(threads.deletedAt),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(queuedThreadMessages.sendAt), asc(queuedThreadMessages.id))
    .all();
}

/**
 * Every live row a given wait owner holds, in queue order. Asked when one
 * plugin's waits must be cleared at once, on its disable or uninstall —
 * clearing by holder is what `wait_holder`'s indexed equality lookup exists
 * for.
 *
 * Ordered by `createdAt` for the same reason as
 * {@link listQueuedThreadMessagesWithPluginWait}: `id` is a random suffix, so
 * it sorts nothing, and one holder's rows span threads so `sortKey` alone
 * cannot order them either.
 */
export function listQueuedThreadMessagesByWaitHolder(
  db: DbQueryConnection,
  waitHolder: QueuedMessageWaitHolder,
): QueuedThreadMessageRow[] {
  return db
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        eq(queuedThreadMessages.waitHolder, waitHolder),
        automaticallyDrainableQueuedThreadMessage(),
      ),
    )
    .orderBy(
      asc(queuedThreadMessages.createdAt),
      asc(queuedThreadMessages.sortKey),
      asc(queuedThreadMessages.id),
    )
    .all();
}

/** The columns the plugin-wait walkers act on; see the query below. */
export interface QueuedThreadMessagePluginWaitRef {
  id: string;
  threadId: string;
  waitHolder: QueuedMessageWaitHolder;
}

/**
 * Every live row on SOME plugin's wait, across every thread, in queue order.
 *
 * The orphan sweep asks this once per tick and then filters by which plugins
 * are loaded, rather than asking per plugin: the set of holders is not known
 * up front (it is whichever plugins happen to be holding something), and the
 * partial wait index covers exactly these rows, so one range scan answers it.
 *
 * Deliberately a projection, not full rows: both walkers only clear waits or
 * re-attempt by id, so returning prompt bodies here would ship every held
 * message's content on a ten-second timer for nothing.
 *
 * Ordered by `createdAt` and NOT by `id`: row ids are random suffixes, so
 * sorting by them is sorting by nothing. It matters because the requested
 * drain re-offers these rows to the dispatch hook in this order, and a full
 * pool is supposed to drain in the order it filled. `sortKey` cannot do the
 * job either — its fractional keys are seeded per thread, so they order a
 * thread's own rows and are meaningless between threads; it breaks a
 * same-millisecond tie within one thread, and `id` makes the sort total.
 */
export function listQueuedThreadMessagePluginWaitRefs(
  db: DbQueryConnection,
): QueuedThreadMessagePluginWaitRef[] {
  return db
    .select({
      id: queuedThreadMessages.id,
      threadId: queuedThreadMessages.threadId,
      waitHolder: queuedThreadMessages.waitHolder,
    })
    .from(queuedThreadMessages)
    .where(
      and(
        isNotNull(queuedThreadMessages.waitHolder),
        automaticallyDrainableQueuedThreadMessage(),
      ),
    )
    .orderBy(
      asc(queuedThreadMessages.createdAt),
      asc(queuedThreadMessages.sortKey),
      asc(queuedThreadMessages.id),
    )
    .all()
    .flatMap((row) =>
      row.waitHolder === null ? [] : [{ ...row, waitHolder: row.waitHolder }],
    );
}

/**
 * A thread's live rows on one kind of wait, in queue order. Read
 * straight out of the stored JSON so the kind has exactly one home; the
 * thread predicate is what makes this selective, so no index on the extracted
 * kind is warranted.
 */
export function listQueuedThreadMessagesWaitingOnKind(
  db: DbQueryConnection,
  args: ListQueuedThreadMessagesWaitingOnKindArgs,
): QueuedThreadMessageRow[] {
  return db
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        eq(queuedThreadMessages.threadId, args.threadId),
        sql`json_extract(${queuedThreadMessages.waitingOn}, '$.kind') = ${args.kind}`,
        automaticallyDrainableQueuedThreadMessage(),
      ),
    )
    .orderBy(asc(queuedThreadMessages.sortKey), asc(queuedThreadMessages.id))
    .all();
}

/**
 * Whether a retry of this original turn request already exists on the queue.
 *
 * Claimed rows count on purpose: a retry a drain has claimed and is deciding
 * about is as live as a waiting one, and the window between its claim and its
 * dispatch is exactly when a second retry of the same turn would otherwise
 * slip past. Targeted on the retry column rather than loading the thread's
 * rows to inspect their payloads.
 */
export function hasQueuedRetryOfTurnRequest(
  db: DbQueryConnection,
  args: { threadId: string; retryOfTurnRequestId: string },
): boolean {
  return (
    db
      .select({ id: queuedThreadMessages.id })
      .from(queuedThreadMessages)
      .where(
        and(
          eq(queuedThreadMessages.threadId, args.threadId),
          eq(
            queuedThreadMessages.retryOfTurnRequestId,
            args.retryOfTurnRequestId,
          ),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

/**
 * Threads on one host with live rows parked on a `host-offline` wait.
 *
 * Joined through the thread's environment by host ID rather than matched on
 * the wait's stored `hostName`: the name on the wait is display text captured
 * at failure time, and a renamed host would orphan every row that matched on
 * it.
 */
export function listThreadIdsWithHostOfflineQueueWaits(
  db: DbQueryConnection,
  hostId: string,
): string[] {
  return db
    .selectDistinct({ threadId: queuedThreadMessages.threadId })
    .from(queuedThreadMessages)
    .innerJoin(threads, eq(threads.id, queuedThreadMessages.threadId))
    .innerJoin(environments, eq(environments.id, threads.environmentId))
    .where(
      and(
        eq(environments.hostId, hostId),
        isNull(threads.archivedAt),
        isNull(threads.deletedAt),
        sql`json_extract(${queuedThreadMessages.waitingOn}, '$.kind') = 'host-offline'`,
        automaticallyDrainableQueuedThreadMessage(),
      ),
    )
    .all()
    .map((row) => row.threadId);
}

export function deleteQueuedThreadRetries(
  db: DbQueryConnection,
  notifier: DbNotifier,
  threadId: string,
): QueuedThreadMessageRow[] {
  const deleted = db
    .delete(queuedThreadMessages)
    .where(
      and(
        eq(queuedThreadMessages.threadId, threadId),
        eq(queuedThreadMessages.payloadKind, "retry"),
      ),
    )
    .returning()
    .all();
  if (deleted.length > 0) notifier.notifyThread(threadId, ["queue-changed"]);
  return deleted;
}

export function deleteQueuedThreadMessage(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
) {
  const existing = db.transaction(
    (tx) => {
      const existing = getQueuedThreadMessage(tx, id);
      if (!existing) return null;
      tx.delete(queuedThreadMessages)
        .where(eq(queuedThreadMessages.id, id))
        .run();
      return existing;
    },
    { behavior: "immediate" },
  );
  if (!existing) return false;
  notifier.notifyThread(existing.threadId, ["queue-changed"]);
  return true;
}
