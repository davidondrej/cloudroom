import {
  clearQueuedThreadMessageWaitingOn,
  createQueuedThreadMessageInTransaction,
  getThread,
  hasQueuedRetryOfTurnRequest,
  listStoredClientTurnRequestRowsByKeys,
  listStoredTurnRejectedRowsByClientRequestIds,
  requeueClaimedQueuedThreadMessage,
  type ClaimedQueuedThreadMessageRow,
  type DbConnection,
  type DbNotifier,
  type DbQueryConnection,
  type DbTransaction,
  type QueuedThreadMessageRow,
} from "@cloudroom/db";
import { permissionModeSchema } from "@cloudroom/domain";
import type {
  ClientTurnRequestId,
  PromptInput,
  QueuedMessagePayload,
  QueuedMessageSystemNotice,
  QueuedMessageWaitingOn,
  ResolvedThreadExecutionOptions,
  Thread,
  ThreadQueuedMessage,
} from "@cloudroom/domain";
import { ApiError } from "../../errors.js";
import {
  emitPluginMessageDispatched,
  emitPluginMessageQueued,
} from "../plugins/plugin-thread-events.js";
import {
  parseStoredTurnRequestEvent,
  type TurnRequestRetryMarker,
} from "./thread-events.js";
import { toThreadQueuedMessage } from "./thread-queued-messages.js";

type QueueWaitDeps = { db: DbQueryConnection; hub: DbNotifier };

export const QUEUED_MESSAGE_CLAIM_LOST_CODE = "queued_message_claim_lost";
export const QUEUED_MESSAGE_AUTO_SEND_PAUSED_CODE =
  "queued_message_auto_send_paused";
export const QUEUED_MESSAGE_NOT_DELIVERED_CODE = "queued_message_not_delivered";

export function createQueuedMessageClaimLostError(): ApiError {
  return new ApiError(
    409,
    QUEUED_MESSAGE_CLAIM_LOST_CODE,
    "Queued message claim expired before it could be sent",
  );
}

export function createQueuedMessageNotDeliveredError(): ApiError {
  return new ApiError(
    409,
    QUEUED_MESSAGE_NOT_DELIVERED_CODE,
    "The thread changed before the message could be sent; it stays queued",
  );
}

export function isQueuedMessageNotDeliveredError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.body.code === QUEUED_MESSAGE_NOT_DELIVERED_CODE
  );
}

export function createQueuedMessageAutoSendPausedError(): ApiError {
  return new ApiError(
    409,
    QUEUED_MESSAGE_AUTO_SEND_PAUSED_CODE,
    "Queued message auto-send was paused by a manual stop",
  );
}

export function isQueuedMessageAutoSendPausedError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.body.code === QUEUED_MESSAGE_AUTO_SEND_PAUSED_CODE
  );
}

/**
 * A settling row, for the plugin event its transition raises.
 *
 * A wait is narrated by the queue rows above the composer, which read the
 * row's own columns — so a settle has nothing to write down, only somebody to
 * tell.
 */
export interface SettleQueueRowArgs {
  row: QueuedThreadMessageRow;
}

/** The message a queued row will carry, as the queueing site supplies it. */
export interface QueuedDispatchMessage {
  input: PromptInput[];
  execution: ResolvedThreadExecutionOptions;
  senderThreadId: string | null;
  payload: QueuedMessagePayload;
  /** Non-null only when core is queueing one of its own system notices. */
  systemNotice: QueuedMessageSystemNotice | null;
}

export interface RecordQueuedMessageWaitArgs {
  thread: Thread;
  message: QueuedDispatchMessage;
  waitingOn: QueuedMessageWaitingOn;
  /**
   * The row's scheduled instant. Passed every time the wait is written rather
   * than left alone, because writing a wait is a fresh statement of when this
   * row may run: a `time` wait sets it, a plugin wait with a `sendAt` sets it,
   * and every other wait clears it by passing null.
   */
  sendAt: number | null;
  /**
   * The row already claimed from the queue that this call is RETURNING rather
   * than creating. Present on every drain re-attempt; absent when an inline
   * send is queued for the first time.
   */
  claimed: ClaimedQueuedThreadMessageRow | null;
}

/**
 * Records that a dispatch is waiting: the single place a queued row comes into
 * existence or has its wait rewritten.
 *
 * Creating and re-queueing are one function because they are one concept —
 * "this message is waiting, and here is why" — and because every caller reaches
 * it from the same place in {@link attemptDispatch}. The difference is only
 * whether a row already exists: a drain re-attempt hands back the row it
 * claimed, an inline attempt has none yet.
 *
 * Returns the row the wait now sits on, or null when a re-queue lost its row
 * (deleted under the drain), which the caller treats as "nothing to do".
 */
export function recordQueuedMessageWait(
  deps: QueueWaitDeps,
  args: RecordQueuedMessageWaitArgs,
): ThreadQueuedMessage | null {
  let row: QueuedThreadMessageRow | null;

  if (args.claimed === null) {
    row = deps.db.transaction(
      (tx) =>
        createQueuedThreadMessageInTransaction(tx, {
          threadId: args.thread.id,
          content: args.message.input,
          senderThreadId: args.message.senderThreadId,
          model: args.message.execution.model,
          reasoningLevel: args.message.execution.reasoningLevel,
          permissionMode: args.message.execution.permissionMode,
          serviceTier: args.message.execution.serviceTier,
          waitingOn: args.waitingOn,
          sendAt: args.sendAt,
          payload: args.message.payload,
          systemNotice: args.message.systemNotice,
        }),
      { behavior: "immediate" },
    );
  } else {
    row = requeueClaimedQueuedThreadMessage(deps.db, deps.hub, {
      claim: { id: args.claimed.id, claimToken: args.claimed.claimToken },
      threadId: args.thread.id,
      waitingOn: args.waitingOn,
      sendAt: args.sendAt,
    });
  }

  if (row === null) {
    // The claim no longer holds: the row was deleted under the drain, or a
    // stale-claim sweep reclaimed it. Either way there is no row left to queue.
    return null;
  }
  const entry = toThreadQueuedMessage(row);
  emitPluginMessageQueued(entry);
  deps.hub.notifyThread(args.thread.id, ["queue-changed"]);
  return entry;
}

/**
 * Records that a queued row's waits all cleared and it dispatched. Called
 * AFTER the row is consumed, so a plugin listening on `message.dispatched` sees
 * the row leave the queue rather than a row that is about to.
 */
export function settleQueueRowDispatched(args: SettleQueueRowArgs): void {
  emitPluginMessageDispatched(toThreadQueuedMessage(args.row));
}

/**
 * Drops a row's wait so the next drain re-attempts it. The row stays exactly
 * where it is in the queue; only its eligibility changes.
 */
export function clearQueuedMessageWait(
  deps: { db: DbConnection; hub: DbNotifier },
  args: { queuedMessageId: string; threadId: string },
): QueuedThreadMessageRow | null {
  return clearQueuedThreadMessageWaitingOn(deps.db, deps.hub, {
    id: args.queuedMessageId,
    threadId: args.threadId,
  });
}

const UNCONFIRMED_SEND_REASON =
  "The computer disconnected before confirming this message. It may still arrive. Send it again if it doesn't.";

/**
 * Puts back a claimed row whose turn was saved and sent, then rejected because
 * the computer disconnected before confirming it (#2279). The computer may
 * still have it, so the row is held by its failure reason: only the user sends
 * it again. It retries the original request, which refuses a second retry.
 */
export function holdUnconfirmedQueuedMessage(
  deps: { db: DbConnection; hub: DbNotifier },
  args: {
    claimed: ClaimedQueuedThreadMessageRow;
    requestId: ClientTurnRequestId;
    retryOf: TurnRequestRetryMarker | undefined;
  },
): void {
  const { claimed } = args;
  const threadId = claimed.threadId;
  const original = args.retryOf?.requestId ?? args.requestId;
  const thread = getThread(deps.db, threadId);
  if (
    thread === null ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    listStoredTurnRejectedRowsByClientRequestIds(deps.db, {
      threadId,
      clientRequestIds: [args.requestId],
      afterSequence: 0,
    }).length === 0 ||
    hasQueuedRetryOfTurnRequest(deps.db, {
      threadId,
      retryOfTurnRequestId: original,
    })
  ) {
    return;
  }
  const row = deps.db.transaction(
    (tx) =>
      createQueuedThreadMessageInTransaction(tx, {
        threadId,
        // Agent-only like any retry: the user's message stays in the chat.
        content: toThreadQueuedMessage(claimed).content.map((block) => ({
          ...block,
          visibility: "agent-only" as const,
        })),
        senderThreadId: claimed.senderThreadId,
        model: claimed.model,
        reasoningLevel: claimed.reasoningLevel,
        permissionMode: claimed.permissionMode,
        serviceTier: claimed.serviceTier,
        waitingOn: null,
        sendAt: null,
        payload: {
          kind: "retry",
          retryOfTurnRequestId: original,
          attempt: (args.retryOf?.attempt ?? 1) + 1,
          reason: "Computer disconnected",
        },
        systemNotice: null,
        hardQueue: claimed.hardQueue,
        sortKey: claimed.sortKey,
        failureReason: UNCONFIRMED_SEND_REASON,
      }),
    { behavior: "immediate" },
  );
  emitPluginMessageQueued(toThreadQueuedMessage(row));
  deps.hub.notifyThread(threadId, ["queue-changed"]);
}

/**
 * Puts back the message of a start the host refused, untouched, because the
 * thread was already running a turn (#1584). It joins that turn once it
 * starts, or follows it, so it still arrives once. Agent-only like any retry:
 * the original message stays in the chat.
 */
export function requeueRefusedTurnRequest(
  deps: { db: DbTransaction; hub: DbNotifier },
  args: { requestId: ClientTurnRequestId; threadId: string },
): ThreadQueuedMessage | null {
  const [row] = listStoredClientTurnRequestRowsByKeys(deps.db, {
    keys: [args],
  });
  if (row === undefined) return null;
  const request = parseStoredTurnRequestEvent(row);
  const original = request.retryOfRequestId ?? request.requestId;
  const permissionMode = permissionModeSchema.safeParse(
    request.execution.permissionMode,
  ).data;
  if (
    request.input.length === 0 ||
    permissionMode === undefined ||
    hasQueuedRetryOfTurnRequest(deps.db, {
      threadId: args.threadId,
      retryOfTurnRequestId: original,
    })
  ) {
    return null;
  }
  const queued = createQueuedThreadMessageInTransaction(deps.db, {
    threadId: args.threadId,
    content: request.input.map((block) => ({
      ...block,
      visibility: "agent-only" as const,
    })),
    senderThreadId: request.senderThreadId,
    model: request.execution.model,
    reasoningLevel: request.execution.reasoningLevel,
    permissionMode,
    serviceTier: request.execution.serviceTier,
    waitingOn: { kind: "turn-starting" },
    sendAt: null,
    // Ahead of what queued since, so it keeps its order (#1584).
    queuedAt: row.createdAt,
    payload: {
      kind: "retry",
      retryOfTurnRequestId: original,
      attempt: (request.retryAttempt ?? 1) + 1,
      reason: "Another turn was running",
    },
    // Only a parent's notice is one: a retry is `system` too, and a stored
    // kind defaults to "unlabeled", so other messages keep their own path.
    systemNotice:
      request.initiator === "system" && request.retryOfRequestId === undefined
        ? {
            kind: request.systemMessageKind ?? "unlabeled",
            subject: request.systemMessageSubject ?? null,
          }
        : null,
  });
  deps.hub.notifyThread(args.threadId, ["queue-changed"]);
  return toThreadQueuedMessage(queued);
}
