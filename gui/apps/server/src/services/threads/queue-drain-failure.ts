import {
  getQueuedThreadMessage,
  getThread,
  listQueuedThreadMessages,
  setQueuedThreadMessageFailureReason,
  setQueuedThreadMessageWaitingOn,
} from "@cloudroom/db";
import {
  QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH,
  type Thread,
} from "@cloudroom/domain";
import { ApiError } from "../../errors.js";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { scrub } from "../cloudroom/setup-telemetry.js";
import { dispatchEnvironmentAndHost } from "./dispatch-hooks.js";
import {
  buildParentSystemInputFromSegments,
  buildParentSystemThreadMention,
  parentSystemThreadLabel,
  queueParentSystemMessage,
} from "./parent-system-messages.js";
import { parseStoredQueuedThreadMessageWaitingOn } from "./thread-queued-messages.js";

type QueueDrainFailureDeps = LoggedPendingInteractionWorkSessionDeps;

/** Failed rows whose sender was already told, so a repeat failure is quiet. */
const sendersToldOfFailedRow = new Set<string>();
/** Archived-queue rows whose sender was told (#1852), apart from failures. */
const sendersToldOfArchivedRow = new Set<string>();

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

  const failureReason = describeDispatchFailure(args.error);
  const failed = setQueuedThreadMessageFailureReason(deps.db, deps.hub, {
    id: args.row.id,
    threadId: args.row.threadId,
    failureReason,
  });
  captureQueueDeliveryProblem(deps, {
    outcome: "failed",
    error: args.error,
    queuedMessageId: args.row.id,
    threadId: args.row.threadId,
  });
  if (failed?.senderThreadId && !sendersToldOfFailedRow.has(failed.id)) {
    sendersToldOfFailedRow.add(failed.id);
    void tellSenderOfFailedQueuedMessage(deps, {
      failureReason,
      queuedMessageId: failed.id,
      recipient: args.thread,
      senderThreadId: failed.senderThreadId,
    });
  }
}

/**
 * The agent that queued this row was told it was accepted, and nobody was
 * listening when the drain failed it, so it is told once here instead of
 * finding out from the recipient's queue (#2662). A user's row shows its
 * failure in the composer, and a Cloud sender can't get the notice.
 */
async function tellSenderOfFailedQueuedMessage(
  deps: QueueDrainFailureDeps,
  args: {
    failureReason: string;
    queuedMessageId: string;
    recipient: Thread;
    senderThreadId: string;
  },
): Promise<void> {
  const { recipient, queuedMessageId: id } = args;
  try {
    await queueParentSystemMessage(deps, {
      parentThreadId: args.senderThreadId,
      input: buildParentSystemInputFromSegments({
        segments: [
          { kind: "text", text: "[system]\n\nYour queued message to " },
          {
            kind: "mention",
            mention: buildParentSystemThreadMention({ thread: recipient }),
          },
          {
            kind: "text",
            text:
              ` failed and was not sent: ${args.failureReason}\n` +
              `It stays in that thread's queue as ${id}. Inspect it with ` +
              `\`room-cli thread queue list ${recipient.id}\`, then retry ` +
              `with \`room-cli thread queue send ${recipient.id} ${id}\` or ` +
              `remove it with \`room-cli thread queue delete ${recipient.id} ${id}\`.`,
          },
        ],
      }),
      systemMessageKind: "unlabeled",
      systemMessageSubject: {
        kind: "thread",
        threadId: recipient.id,
        threadName: parentSystemThreadLabel(recipient),
      },
    });
  } catch (error) {
    deps.logger.warn(
      { err: error, queuedMessageId: id, senderThreadId: args.senderThreadId },
      "Could not tell a sender its queued message failed",
    );
  }
}

/**
 * An archived thread's queue never sends on its own, so each agent with a
 * message waiting there is told once, naming the thread (#1852). The rows stay
 * for an unarchive. A tick later, so a sender archived in the same cascade is
 * skipped; a drain the archive interrupted calls this again once its row is
 * back. A row counts as told only once its notice went. Its own record, so a
 * later drain failure still gets the #2662 notice.
 */
export function tellSendersOfArchivedThreadQueue(
  deps: QueueDrainFailureDeps,
  recipient: Thread,
): void {
  setImmediate(() => {
    const idsBySender = new Map<string, string[]>();
    let archivedAt: number | null | undefined;
    try {
      // An archive undone before this tick tells nobody; a later archive is new.
      archivedAt = getThread(deps.db, recipient.id)?.archivedAt;
      if (!archivedAt) return;
      for (const row of listQueuedThreadMessages(deps.db, recipient.id)) {
        // A failed row already got its #2662 notice and never auto-sends.
        if (!row.senderThreadId || row.failureReason !== null) continue;
        const key = `${row.id}:${archivedAt}`;
        if (sendersToldOfArchivedRow.has(key)) continue;
        sendersToldOfArchivedRow.add(key);
        idsBySender.set(row.senderThreadId, [
          ...(idsBySender.get(row.senderThreadId) ?? []),
          row.id,
        ]);
      }
    } catch {
      return; // A closed database (shutdown) must not throw outside any caller.
    }
    for (const [senderThreadId, ids] of idsBySender) {
      void queueParentSystemMessage(deps, {
        parentThreadId: senderThreadId,
        input: buildParentSystemInputFromSegments({
          segments: [
            { kind: "text", text: "[system]\n\n" },
            {
              kind: "mention",
              mention: buildParentSystemThreadMention({ thread: recipient }),
            },
            {
              kind: "text",
              text:
                ` was archived, so your queued messages there were not sent: ${ids.join(", ")}. ` +
                `They stay in its queue and send only if it is unarchived. ` +
                `Inspect with \`room-cli thread queue list ${recipient.id}\`.`,
            },
          ],
        }),
        systemMessageKind: "unlabeled",
        systemMessageSubject: {
          kind: "thread",
          threadId: recipient.id,
          threadName: parentSystemThreadLabel(recipient),
        },
      })
        .then((told) => {
          if (!told)
            for (const id of ids)
              sendersToldOfArchivedRow.delete(`${id}:${archivedAt}`);
        })
        .catch((error: unknown) => {
          for (const id of ids)
            sendersToldOfArchivedRow.delete(`${id}:${archivedAt}`);
          deps.logger.warn(
            { err: error, threadId: recipient.id, senderThreadId },
            "Could not tell a sender its queued message's thread was archived",
          );
        });
    }
  });
}
