import {
  getLastStoredTurnRequestEvent,
  getLatestStoredRateLimitsEventForProvider,
  getLatestStoredThreadEventOfTypes,
  getThread,
  getThreadExecutionOverride,
  listStoredTurnInputAcceptedRowsByClientRequestIds,
  listStoredTurnRejectedRowsByClientRequestIds,
  type DbConnection,
  type StoredThreadEventDataRow,
} from "@cloudroom/db";
import {
  providerErrorInfoSchema,
  providerRateLimitStateSchema,
  systemErrorEventDataSchema,
  systemThreadInterruptedEventDataSchema,
  type ClientTurnRequestId,
  type ProviderErrorInfo,
  type ProviderRateLimitState,
  type Thread,
  type TurnRequestEventData,
} from "@cloudroom/domain";
import os from "node:os";
import type { PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { parseStoredTurnRequestEvent } from "./thread-events.js";

/** The message shapes the fallback query can return, by event type. */
const providerErrorDataSchema = z.object({
  message: z.string(),
  detail: z.string().optional(),
  errorInfo: providerErrorInfoSchema.optional(),
});

const rateLimitsDataSchema = z.object({
  rateLimits: providerRateLimitStateSchema,
});

const rejectedReasonDataSchema = z.object({
  reason: z.string(),
});

function parseRowData(row: StoredThreadEventDataRow): unknown {
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

export interface FailedTurnRecord {
  request: TurnRequestEventData;
  requestSequence: number;
  requestedAt: number;
}

/**
 * The turn whose failure just landed: the most recent request on the thread.
 *
 * A failure applies at the moment the thread leaves `active`/`starting`, and
 * nothing else can have appended a request in between — the send path only
 * appends one while dispatching, and a queue drain waits for the thread to be
 * quiescent, which this failure is what makes it. Returns null for a thread
 * that has never dispatched a turn (a start that failed before any request),
 * where there is nothing to announce and nothing for a retry to re-submit.
 */
export function loadFailedTurn(
  db: DbConnection,
  threadId: string,
): FailedTurnRecord | null {
  const row = getLastStoredTurnRequestEvent(db, threadId);
  if (row === null) return null;
  try {
    return {
      request: parseStoredTurnRequestEvent(row),
      requestSequence: row.sequence,
      requestedAt: row.createdAt,
    };
  } catch {
    return null;
  }
}

/**
 * Which attempt failed, and which request the chain started from.
 *
 * Both come off the failed request itself rather than a tally: the marker
 * written when a retry dispatched IS the counter, so restarts, re-queues and a
 * server that never saw the earlier attempts all arrive at the same number.
 */
export function retryChain(request: TurnRequestEventData): {
  attemptNumber: number;
  originalRequestId: ClientTurnRequestId;
} {
  return {
    attemptNumber: request.retryAttempt ?? 1,
    originalRequestId: request.retryOfRequestId ?? request.requestId,
  };
}

/**
 * Whether the provider accepted the failed turn's input before the failure.
 *
 * Acceptance is the provider's own statement that the input entered its
 * conversation, recorded as the mandatory `turn/input/accepted` event keyed by
 * the request id. It is the fact that splits a failure into its two shapes:
 * accepted-then-failed means the provider holds the message (and possibly
 * partial output) that no provider rolls back, while never-accepted means the
 * request died at the door and the provider has no record of it.
 */
export function wasFailedTurnInputAccepted(
  db: DbConnection,
  args: { threadId: string; failed: FailedTurnRecord },
): boolean {
  return (
    listStoredTurnInputAcceptedRowsByClientRequestIds(db, {
      threadId: args.threadId,
      clientRequestIds: [args.failed.request.requestId],
      afterSequence: args.failed.requestSequence,
    }).length > 0
  );
}

/**
 * The structured classification of a request the provider refused at the door.
 *
 * A rejected dispatch never produces a `provider/error` event — no provider
 * turn existed to carry one — so the typed code the runtime attached to the
 * `client/turn/rejected` row is the failure's only classification. Mapping it
 * here is what lets a retry policy see a door-rejected rate limit as the same
 * category a mid-stream one reports; unmapped reasons stay null, exactly as
 * before.
 */
function doorRejectionErrorInfo(
  db: DbConnection,
  args: { threadId: string; failed: FailedTurnRecord },
): ProviderErrorInfo | null {
  const row = listStoredTurnRejectedRowsByClientRequestIds(db, {
    threadId: args.threadId,
    clientRequestIds: [args.failed.request.requestId],
    afterSequence: args.failed.requestSequence,
  })[0];
  if (row === undefined) return null;
  const reason = rejectedReasonDataSchema.safeParse(parseRowData(row)).data
    ?.reason;
  switch (reason) {
    case "rate_limited":
      return {
        category: "rate-limit",
        providerCode: null,
        httpStatusCode: null,
      };
    case "auth_required":
      return {
        category: "unauthorized",
        providerCode: null,
        httpStatusCode: null,
      };
    default:
      return null;
  }
}

/**
 * The `turn.failed` payload: ids and failure facts, assembled from the failed
 * turn's own records so a listener never replays the event log itself.
 *
 * Deliberately carries no thread DTO and no copy of the message. A retry is
 * asked for BY REFERENCE (`sdk.threads.retry`), so the request id is the whole
 * of what a policy needs, and a listener that wants more reads it when it uses
 * it rather than being handed a snapshot that is already aging.
 *
 * Returns null when the thread is gone or never dispatched a turn — there is
 * no failed turn to announce.
 */
export function buildTurnFailedEvent(
  db: DbConnection,
  threadId: string,
): PluginTurnFailedEvent | null {
  const thread = getThread(db, threadId);
  if (!thread || thread.deletedAt !== null || thread.archivedAt !== null) {
    return null;
  }
  const failed = loadFailedTurn(db, threadId);
  if (failed === null) return null;
  const providerError = loadProviderError(db, { threadId, failed });
  return {
    threadId,
    requestId: failed.request.requestId,
    turnId: providerError?.turnId ?? null,
    errorInfo:
      providerError?.errorInfo ??
      doorRejectionErrorInfo(db, { threadId, failed }),
    inputAccepted: wasFailedTurnInputAccepted(db, { threadId, failed }),
    rateLimits: latestRateLimits(db, thread, failed.requestSequence, providerError?.turnId),
    attemptNumber: retryChain(failed.request).attemptNumber,
    interruptionReason: interruptionReason(db, { threadId, failed }),
    turnStartedBeforeBoot:
      thread.executionTarget !== "cloud" &&
      failed.requestedAt < Date.now() - os.uptime() * 1_000,
  };
}

/**
 * The provider's own account of the failure, when the failure happened inside
 * a provider turn at all: its turn id and its classification.
 */
function loadProviderError(
  db: DbConnection,
  args: { threadId: string; failed: FailedTurnRecord },
): { turnId: string | null; errorInfo: ProviderErrorInfo | null } | null {
  const row = getLatestStoredThreadEventOfTypes(db, {
    threadId: args.threadId,
    types: ["provider/error"],
    afterSequence: args.failed.requestSequence,
  });
  if (row === null) return null;
  return {
    turnId: row.turnId,
    errorInfo:
      providerErrorDataSchema.safeParse(parseRowData(row)).data?.errorInfo ??
      null,
  };
}

/** Who started a turn: a person in the app, a script through the API or CLI, an agent, or Cloudroom itself. */
export type TurnStarter = "person" | "script" | "agent" | "system";

/**
 * Facts for the `turn_failed` telemetry event that `turn.failed` doesn't carry.
 *
 * `code`: our own fixed code for the failure, read from where it happened,
 * never guessed from its text: an interruption's reason, then the host's or
 * runtime's code on the turn's error, then the code the request was rejected
 * with. Null when the turn left none of them.
 *
 * `startedBy`: null when the request didn't record its surface (Cloud
 * prompts, and apps before this field).
 */
export function turnFailureFacts(
  db: DbConnection,
  threadId: string,
): { code: string | null; startedBy: TurnStarter | null } {
  const failed = loadFailedTurn(db, threadId);
  if (failed === null) return { code: null, startedBy: null };
  const args = { threadId, failed };
  const code =
    interruptionCode(db, args) ??
    systemErrorCode(db, args) ??
    rejectionCode(db, args);
  return {
    code: code === null ? null : code.replaceAll("_", "-"),
    startedBy: turnStarter(failed.request),
  };
}

/** Who started the thread's last turn, if it was requested at or after `afterSequence`: Local sends are recorded just
 *  after their own request is saved. */
export function turnStarterAfter(db: DbConnection, threadId: string, afterSequence: number): TurnStarter | null {
  const turn = loadFailedTurn(db, threadId);
  return turn !== null && turn.requestSequence >= afterSequence ? turnStarter(turn.request) : null;
}

function turnStarter(request: TurnRequestEventData): TurnStarter | null {
  if (request.initiator !== "user") return request.initiator;
  if (request.appSurface === undefined) return null;
  return request.appSurface === "api" ? "script" : "person";
}

function interruptionCode(
  db: DbConnection,
  args: { threadId: string; failed: FailedTurnRecord },
): string | null {
  const row = getLatestStoredThreadEventOfTypes(db, {
    threadId: args.threadId,
    types: ["system/thread/interrupted"],
    afterSequence: args.failed.requestSequence,
  });
  const data = row
    ? systemThreadInterruptedEventDataSchema.safeParse(parseRowData(row)).data
    : undefined;
  if (data === undefined) return null;
  switch (data.reason) {
    case "host-daemon-restarted":
      return data.cause ?? "host-disconnected";
    case "provider-turn-idle":
      return "stalled";
    case "manual-stop":
      return "stopped";
    default:
      return data.reason;
  }
}

function systemErrorCode(
  db: DbConnection,
  args: { threadId: string; failed: FailedTurnRecord },
): string | null {
  const row = getLatestStoredThreadEventOfTypes(db, {
    threadId: args.threadId,
    types: ["system/error"],
    afterSequence: args.failed.requestSequence,
  });
  const data = row
    ? systemErrorEventDataSchema.safeParse(parseRowData(row)).data
    : undefined;
  return data?.cause ?? data?.code ?? null;
}

function rejectionCode(
  db: DbConnection,
  args: { threadId: string; failed: FailedTurnRecord },
): string | null {
  const row = listStoredTurnRejectedRowsByClientRequestIds(db, {
    threadId: args.threadId,
    clientRequestIds: [args.failed.request.requestId],
    afterSequence: args.failed.requestSequence,
  })[0];
  return row === undefined
    ? null
    : (rejectedReasonDataSchema.safeParse(parseRowData(row)).data?.reason ??
        null);
}

/**
 * Why the thread's last turn failed, for `thread.failed`: the provider's
 * words ("You've hit your weekly limit") and the same classification
 * `turn.failed` carries. Both null when the turn left neither.
 */
export function describeFailedTurn(
  db: DbConnection,
  threadId: string,
): { message: string | null; errorInfo: ProviderErrorInfo | null } {
  const failed = loadFailedTurn(db, threadId);
  if (failed === null) return { message: null, errorInfo: null };
  const providerError = loadProviderError(db, { threadId, failed });
  // The turn's last error of either kind; both carry `message`.
  const last = getLatestStoredThreadEventOfTypes(db, {
    threadId,
    types: ["provider/error", "system/error"],
    afterSequence: failed.requestSequence,
  });
  const data =
    last === null
      ? undefined
      : providerErrorDataSchema.safeParse(parseRowData(last)).data;
  // A provider error's message is generic ("Provider error"), so its detail says why. A system error's message is the
  // cause and its detail only adds to it (stderr, a diagnostic ID), as in getTurnErrorText (#949).
  const message =
    last?.type === "system/error"
      ? [data?.message, data?.detail].filter(Boolean).join(": ")
      : data?.detail || data?.message;
  return {
    message: message || null,
    errorInfo:
      providerError?.errorInfo ??
      doorRejectionErrorInfo(db, { threadId, failed }),
  };
}

/**
 * What holds messages to a thread in `error`, read from its failed turn once.
 *
 * `plan-limit`: the provider still reports a blocked window with a reset ahead,
 * so child reports wait (#1723). `sign-in`: the agent's login failed, so every
 * message from another thread waits instead of failing the same way and
 * notifying its parent again (#2019). Either ends when a turn runs again (an
 * account switch, a retry, the user's message) or when the thread's next turn
 * would use another agent or model.
 */
export function failureHold(
  db: DbConnection,
  thread: Thread,
  now = Date.now(),
): "plan-limit" | "sign-in" | null {
  if (thread.status !== "error") return null;
  const failed = loadFailedTurn(db, thread.id);
  if (failed === null) return null;
  const args = { threadId: thread.id, failed };
  const category = (
    loadProviderError(db, args)?.errorInfo ?? doorRejectionErrorInfo(db, args)
  )?.category;
  if (category !== "rate-limit" && category !== "unauthorized") return null;
  // A switch of agent always sets the model, so it ends the hold like a model switch.
  const model = failed.request.execution.model;
  const override = getThreadExecutionOverride(db, thread.id)?.modelOverride;
  if ((override ?? model) !== model) return null;
  if (category === "unauthorized") return "sign-in";
  const limits = latestRateLimits(db, thread, failed.requestSequence);
  return limits?.status === "blocked" &&
    limits.windows.some(
      (window) =>
        window.status === "blocked" &&
        window.resetsAtMs !== null &&
        window.resetsAtMs > now,
    )
    ? "plan-limit"
    : null;
}

function interruptionReason(
  db: DbConnection,
  args: { threadId: string; failed: FailedTurnRecord },
): PluginTurnFailedEvent["interruptionReason"] {
  const row = getLatestStoredThreadEventOfTypes(db, {
    threadId: args.threadId,
    types: ["system/thread/interrupted"],
    afterSequence: args.failed.requestSequence,
  });
  if (row === null) return null;
  return (
    systemThreadInterruptedEventDataSchema.safeParse(parseRowData(row)).data
      ?.reason ?? null
  );
}

function latestRateLimits(
  db: DbConnection,
  thread: Thread,
  requestSequence: number,
  turnId?: string | null,
): ProviderRateLimitState | null {
  const row = getLatestStoredRateLimitsEventForProvider(db, {
    threadId: thread.id,
    providerId: thread.providerId,
  });
  if (!row || row.sequence <= requestSequence || (turnId && row.turnId && row.turnId !== turnId))
    return null;
  return (
    rateLimitsDataSchema.safeParse(parseRowData(row)).data?.rateLimits ?? null
  );
}
