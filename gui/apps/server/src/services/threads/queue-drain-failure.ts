import {
  getQueuedThreadMessage,
  getThread,
  setQueuedThreadMessageFailureReason,
  setQueuedThreadMessageWaitingOn,
} from "@cloudroom/db";
import {
  QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH,
  type Thread,
} from "@cloudroom/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { scrub } from "../cloudroom/setup-telemetry.js";
import { dispatchEnvironmentAndHost } from "./dispatch-hooks.js";
import { parseStoredQueuedThreadMessageWaitingOn } from "./thread-queued-messages.js";

type QueueDrainFailureDeps = Pick<AppDeps, "db" | "hub" | "telemetry">;

/**
 * Tells us a queued message failed or a system notice was dropped, so the
 * cause is one query away instead of in a log on the user's machine (#1341).
 * Categories and the error only: no message text and no IDs.
 */
export function captureQueueDeliveryProblem(
  deps: Pick<AppDeps, "db" | "telemetry">,
  args: {
    outcome: "failed" | "dropped";
    error: unknown;
    /** A system notice's kind, when there is no queued row to read it from. */
    notice?: string;
    queuedMessageId?: string;
    threadId: string;
  },
): void {
  // Reporting must never turn one failure into two.
  try {
    const row =
      args.queuedMessageId === undefined
        ? null
        : getQueuedThreadMessage(deps.db, args.queuedMessageId);
    const notice =
      args.notice ??
      (row?.systemNotice
        ? (JSON.parse(row.systemNotice) as { kind: string }).kind
        : null);
    const { error } = args;
    deps.telemetry.capture({
      name: "queue_delivery",
      properties: {
        outcome: args.outcome,
        message: notice ?? (row?.senderThreadId ? "agent" : "user"),
        waiting_on:
          row === null
            ? null
            : (parseStoredQueuedThreadMessageWaitingOn(row)?.kind ?? null),
        thread_status: getThread(deps.db, args.threadId)?.status ?? null,
        error:
          error instanceof ApiError
            ? error.body.code
            : error instanceof Error
              ? error.name
              : null,
        detail: error instanceof Error ? scrub(error.message) : null,
      },
    });
  } catch {
    return;
  }
}

/**
 * What a failed dispatch says to the person whose message did not go.
 *
 * `ApiError` messages are already written for a caller, so they pass through.
 * Anything else is an internal fault whose message was written for a log, so
 * the row gets a sentence that is true without pretending to diagnose.
 */
export function describeDispatchFailure(error: unknown): string {
  const message =
    error instanceof ApiError
      ? error.body.message
      : "The message could not be sent.";
  return message.length <= QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH
    ? message
    : `${message.slice(0, QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH - 1)}…`;
}

/**
 * Settles a DRAIN attempt that neither dispatched nor queued.
 *
 * Two outcomes, and which one applies is decided by asking the world rather
 * than by pattern-matching the error: if the thread's host has no live daemon
 * session *right now*, the attempt did not fail so much as arrive at a machine
 * that is not there, and the row re-queues on a `host-offline` wait that the
 * host-reconnect drain clears when the machine comes back. Any other failure
 * is recorded as the row's failure reason, leaving its existing wait alone —
 * the row is still waiting on whatever it was waiting on, and what went wrong
 * last time is a different fact from what it is waiting for.
 *
 * Only the drain calls this. An inline attempt has a caller still listening
 * and surfaces its error to them instead, which is why a queued row never
 * shows a failure the sender was already told about to their face.
 */
export function recordQueuedMessageDrainFailure(
  deps: QueueDrainFailureDeps,
  args: {
    error: unknown;
    row: { id: string; threadId: string };
    thread: Thread;
  },
): void {
  const { host } = dispatchEnvironmentAndHost(deps, args.thread.environmentId);
  if (host !== null && host.status === "disconnected") {
    setQueuedThreadMessageWaitingOn(deps.db, deps.hub, {
      id: args.row.id,
      threadId: args.row.threadId,
      waitingOn: { kind: "host-offline", hostName: host.name },
      // An offline host is not a schedule. Whatever instant this row carried
      // has already passed by the time a drain picked it up, and keeping it
      // would leave the due sweep re-claiming a row that cannot dispatch.
      sendAt: null,
    });
    return;
  }

  setQueuedThreadMessageFailureReason(deps.db, deps.hub, {
    id: args.row.id,
    threadId: args.row.threadId,
    failureReason: describeDispatchFailure(args.error),
  });
  captureQueueDeliveryProblem(deps, {
    outcome: "failed",
    error: args.error,
    queuedMessageId: args.row.id,
    threadId: args.row.threadId,
  });
}
