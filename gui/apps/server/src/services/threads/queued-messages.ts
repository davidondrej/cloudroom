import {
  claimQueuedThreadMessage,
  claimNextQueuedThreadMessage,
  createQueuedThreadMessageInTransaction,
  deleteClaimedQueuedThreadMessageInTransaction,
  getQueuedThreadMessage,
  getEnvironment,
  getHost,
  getThread,
  isOrdinaryTurnEndQueuedMessage,
  isThreadQueueAutoSendPaused,
  releaseQueuedMessageClaim,
  releaseStaleQueuedMessageClaims,
  type ClaimedQueuedThreadMessageRow,
  type DbQueryConnection,
  type QueuedThreadMessageClaimPolicy,
  type QueuedThreadMessageEligibility,
} from "@cloudroom/db";
import { queuedMessageSystemNoticeSchema } from "@cloudroom/domain";
import type {
  PromptInput,
  QueuedMessageWaitingOn,
  Thread,
  ThreadQueuedMessage,
  ThreadTurnInitiator,
} from "@cloudroom/domain";
import type {
  CreateQueuedMessageRequest,
  SendMessageRequest,
  SendQueuedMessageMode,
} from "@cloudroom/server-contract";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { ApiError } from "../../errors.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import {
  LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  startLiveHostCommand,
} from "../hosts/live-command.js";
import { isCommandTimeoutError } from "../lib/error-log-fields.js";
import {
  parseStoredQueuedThreadMessageWaitingOn,
  toThreadQueuedMessage,
} from "./thread-queued-messages.js";
import {
  addRequestIdToTurnSubmitCommandPayload,
  buildExecutionOptions,
  prepareTurnSubmitCommandPayload,
} from "./thread-commands.js";
import {
  prependDeferredFirstTurnContext,
  requireDeferredFirstTurnContextCurrent,
  resolveDeferredFirstTurnContext,
} from "./deferred-first-turn-context.js";
import { appendClientTurnEventInTransaction } from "./thread-events.js";
import {
  getActiveTurnId,
  getLastProviderThreadId,
  isManualCompactionActive,
} from "./thread-events.js";
import { requireReadyThreadEnvironment } from "./thread-turn-dispatch.js";
import { hasMessageDispatchHooks } from "./dispatch-hooks.js";
import { attemptDispatch } from "./dispatch-attempt.js";
import { deliverParentSystemMessage } from "./parent-system-messages.js";
import {
  createQueuedMessageAutoSendPausedError,
  createQueuedMessageClaimLostError,
  QUEUED_MESSAGE_AUTO_SEND_PAUSED_CODE,
  QUEUED_MESSAGE_CLAIM_LOST_CODE,
  settleQueueRowDispatched,
} from "./queue-waits.js";
import { recordQueuedMessageDrainFailure } from "./queue-drain-failure.js";
import {
  appendPluginMentionContext,
  captureUserMessageSentTelemetry,
  ensureThreadQueueIsWritable,
  formatAgentThreadInput,
  resolveMessageSenderThreadId,
} from "./thread-send.js";
import { recordAcceptedPromptHistoryEntry } from "../prompt-history.js";
import { requireThreadCommandEnvironment } from "./thread-command-environment.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "./lifecycle-outcome.js";
import { buildThreadStatusChangeMetadata } from "./thread-runtime-display.js";
import {
  goneThreadEnvironmentDetails,
  threadEnvironmentUnavailableDetails,
  throwThreadEnvironmentUnavailable,
} from "../lib/lifecycle-api-errors.js";
import { validatePromptAttachmentReferences } from "../projects/attachments.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import { isHardQueueHeld } from "./thread-parent.js";
import {
  ThreadContextClearInProgressError,
  withThreadSendGuard,
} from "./thread-context-mutation-guard.js";

interface SendQueuedMessageArgs {
  claimPolicy: QueuedThreadMessageClaimPolicy;
  mode: SendQueuedMessageMode;
  queuedMessageId: string;
  threadId: string;
}

interface SendClaimedQueuedMessageArgs {
  mode: SendQueuedMessageMode;
  queuedMessage: ClaimedQueuedThreadMessageRow;
  /** True for an explicit "send now"; false for an ordinary drain. */
  sendNow: boolean;
  threadId: string;
}

interface SendClaimedQueuedMessageForThreadArgs {
  mode: SendQueuedMessageMode;
  queuedMessage: ClaimedQueuedThreadMessageRow;
  sendNow: boolean;
  thread: Thread;
}

export function createAutomaticQueuedMessageEligibility(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { now: number; thread: Thread },
): QueuedThreadMessageEligibility {
  const activeTurnId = getActiveTurnId(deps, args.thread.id);
  let hardQueueHeld: boolean | undefined;
  return (row) => {
    if (row.failureReason !== null) return false;
    if (row.hardQueue) {
      hardQueueHeld ??= isHardQueueHeld(deps.db, args.thread);
      if (hardQueueHeld) return false;
    }
    const waitingOn = parseStoredQueuedThreadMessageWaitingOn(row);
    switch (waitingOn?.kind) {
      case undefined:
      case "plugin":
        return true;
      case "time":
        return row.sendAt !== null && row.sendAt <= args.now;
      case "thread-busy":
      case "stopping":
        return (
          args.thread.status === "idle" || args.thread.status === "pending"
        );
      case "turn-starting":
        return (
          args.thread.status === "idle" ||
          (args.thread.status === "active" && activeTurnId !== null)
        );
      case "host-offline": {
        const environment =
          args.thread.environmentId === null
            ? null
            : getEnvironment(deps.db, args.thread.environmentId);
        const host =
          environment === null ? null : getHost(deps.db, environment.hostId);
        return (
          host !== null &&
          host.destroyedAt === null &&
          host.phase === "active" &&
          deps.hub.hasDaemonForHost(host.id)
        );
      }
      case "provisioning":
      case "interaction":
        return false;
    }
  };
}

async function requireReadyQueuedMessageEnvironment(
  deps: LoggedPendingInteractionWorkSessionDeps,
  thread: Thread,
) {
  const environment = await requireThreadCommandEnvironment(deps, { thread });
  return requireReadyThreadEnvironment(environment);
}

export interface CreateQueuedMessageForThreadArgs {
  payload: CreateQueuedMessageRequest;
  thread: Thread;
}

function admitQueuedMessage(
  db: DbQueryConnection,
  thread: Thread,
): { providerThreadId: string | null } {
  ensureThreadQueueIsWritable(thread);
  const providerThreadId = getLastProviderThreadId({ db }, thread.id);
  if (thread.environmentId === null) {
    if (providerThreadId !== null) {
      throwThreadEnvironmentUnavailable(
        threadEnvironmentUnavailableDetails("never_attached", null),
      );
    }
    return { providerThreadId };
  }
  const environment = getEnvironment(db, thread.environmentId);
  const goneDetails = environment
    ? goneThreadEnvironmentDetails(environment)
    : null;
  if (goneDetails) {
    throwThreadEnvironmentUnavailable(goneDetails);
  }
  return { providerThreadId };
}

import { cloudExecution, cloudroom, isCloudThread } from "../cloudroom/commands.js";

export async function createQueuedMessageForThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: CreateQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage> {
  const { payload, thread } = args;
  if (isCloudThread(thread)) {
    const sentAt = Date.now();
    const queued = await cloudroom(deps).queueMessage(thread, { ...payload, mode: "queue-if-active" });
    if (!payload.senderThreadId && payload.input.length > 0) {
      captureUserMessageSentTelemetry(deps, { execution: cloudExecution(deps, thread.id), isChildThread: thread.parentThreadId !== null, messageSource: "queued_message", providerId: thread.providerId, sentAt, threadId: thread.id });
    }
    return queued;
  }
  ensureThreadQueueIsWritable(thread);
  await validatePromptAttachmentReferences({
    dataDir: deps.config.dataDir,
    input: payload.input,
    projectId: thread.projectId,
  });
  const execution = await buildExecutionOptions(deps, payload, {
    threadId: thread.id,
  });
  const senderThreadId = resolveMessageSenderThreadId(deps, {
    senderThreadId: payload.senderThreadId,
    targetThread: thread,
  });
  const { currentThread, providerThreadId, queuedMessage } =
    deps.db.transaction(
      (tx) => {
        const currentThread = getThread(tx, thread.id);
        if (!currentThread) {
          throw new ApiError(404, "thread_not_found", "Thread not found");
        }
        const { providerThreadId } = admitQueuedMessage(tx, currentThread);
        const queuedMessage = createQueuedThreadMessageInTransaction(tx, {
          threadId: thread.id,
          content: payload.input,
          senderThreadId,
          model: execution.model,
          reasoningLevel: execution.reasoningLevel,
          permissionMode: execution.permissionMode,
          serviceTier: execution.serviceTier,
          // An explicit "queue this" is a message waiting for the running turn
          // to end, which is exactly `thread-busy`. Naming it rather than
          // leaving the wait null keeps every row on one vocabulary, and the
          // idle drain treats the two identically anyway.
          //
          // Queued while the thread is stopping, it is instead a message the
          // user composed AFTER asking for the stop, so it carries `stopping`
          // and runs when the stop lands rather than joining the rows the
          // manual-stop pause holds back.
          waitingOn:
            currentThread.status === "stopping"
              ? { kind: "stopping" }
              : { kind: "thread-busy" },
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
          hardQueue: payload.hardQueue === true,
        });
        return { currentThread, providerThreadId, queuedMessage };
      },
      { behavior: "immediate" },
    );
  deps.hub.notifyThread(thread.id, ["queue-changed"]);
  if (senderThreadId === null && payload.input.length > 0) {
    captureUserMessageSentTelemetry(deps, {
      isChildThread: thread.parentThreadId !== null,
      messageSource: "queued_message",
      providerId: thread.providerId,
      threadId: thread.id,
    });
  }
  if (currentThread.status === "idle" && providerThreadId !== null) {
    requestQueuedMessageDispatch(deps, {
      kind: "thread-ready",
      threadId: thread.id,
    });
  }
  return toThreadQueuedMessage(queuedMessage);
}

function isQueuedMessageAutoSendCandidate(
  thread: Thread | null,
): thread is Thread {
  return (
    thread !== null &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.status !== "stopping"
  );
}

interface FormatQueuedMessageInputForSenderArgs {
  input: PromptInput[];
  senderThreadId: string | null;
}

const STALE_QUEUED_MESSAGE_CLAIM_MS = 5 * 60 * 1000;
const activeQueuedMessageClaimTokens = new Set<string>();

function respectsManualStopPause(
  args: SendClaimedQueuedMessageForThreadArgs,
): boolean {
  return (
    args.mode === "auto" &&
    !args.sendNow &&
    isOrdinaryTurnEndQueuedMessage(args.queuedMessage)
  );
}

function sendQueuedMessagePayload(
  queuedMessage: ThreadQueuedMessage,
  mode: SendQueuedMessageMode,
  senderThreadId: string | null,
): SendMessageRequest {
  return {
    input: queuedMessage.content,
    mode,
    model: queuedMessage.model,
    permissionMode: queuedMessage.permissionMode,
    reasoningLevel: queuedMessage.reasoningLevel,
    serviceTier: queuedMessage.serviceTier,
    ...(senderThreadId !== null ? { senderThreadId } : {}),
  };
}

function formatQueuedMessageInputForSender(
  args: FormatQueuedMessageInputForSenderArgs,
): PromptInput[] {
  if (args.senderThreadId === null) {
    return args.input;
  }
  return formatAgentThreadInput({
    input: args.input,
    senderThreadId: args.senderThreadId,
  });
}

function releaseClaim(
  deps: Pick<AppDeps, "db" | "hub">,
  queuedMessage: ClaimedQueuedThreadMessageRow,
): void {
  releaseQueuedMessageClaim(deps.db, deps.hub, {
    id: queuedMessage.id,
    claimToken: queuedMessage.claimToken,
  });
}

async function withActiveQueuedMessageClaim<T>(
  queuedMessage: ClaimedQueuedThreadMessageRow,
  task: () => Promise<T>,
): Promise<T> {
  activeQueuedMessageClaimTokens.add(queuedMessage.claimToken);
  try {
    return await task();
  } finally {
    activeQueuedMessageClaimTokens.delete(queuedMessage.claimToken);
  }
}

function claimQueuedThreadMessageForSend(
  deps: Pick<AppDeps, "db" | "hub">,
  args: SendQueuedMessageArgs,
): ClaimedQueuedThreadMessageRow | null {
  const existingQueuedMessage = getQueuedThreadMessage(
    deps.db,
    args.queuedMessageId,
  );
  if (
    !existingQueuedMessage ||
    existingQueuedMessage.threadId !== args.threadId
  ) {
    throw new ApiError(404, "invalid_request", "Queued message not found");
  }

  const claimedQueuedMessage = claimQueuedThreadMessage(
    deps.db,
    deps.hub,
    args.queuedMessageId,
    args.claimPolicy,
  );
  if (claimedQueuedMessage) {
    return claimedQueuedMessage;
  }
  if (args.claimPolicy.kind === "automatic") return null;

  const latestQueuedMessage = getQueuedThreadMessage(
    deps.db,
    args.queuedMessageId,
  );
  if (!latestQueuedMessage || latestQueuedMessage.threadId !== args.threadId) {
    throw new ApiError(404, "invalid_request", "Queued message not found");
  }
  throw new ApiError(
    409,
    "invalid_request",
    "Queued message is already being sent",
  );
}

function isQueuedMessageClaimLostError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.body.code === QUEUED_MESSAGE_CLAIM_LOST_CODE
  );
}

function isQueuedMessageAutoSendPausedError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.body.code === QUEUED_MESSAGE_AUTO_SEND_PAUSED_CODE
  );
}

async function sendClaimedQueuedMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageArgs,
): Promise<ThreadQueuedMessage> {
  const thread = getThread(deps.db, args.threadId);
  if (!thread) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  return sendClaimedQueuedMessageForThread(deps, {
    mode: args.mode,
    queuedMessage: args.queuedMessage,
    sendNow: args.sendNow,
    thread,
  });
}

async function sendClaimedQueuedMessageForIdleProviderThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage | null> {
  if (args.mode !== "auto") {
    return null;
  }
  // This fast path dispatches straight to the daemon, bypassing the dispatch
  // checkpoint. With a hook installed the drain takes the general path instead,
  // so there is exactly one place a turn is decided about. With none (the
  // overwhelming case) this check is a boolean and the drain is byte-for-byte
  // what it was before the queue carried waits: the row it claims is already
  // known drainable, so every core wait it could hit has been answered by the
  // claim query itself.
  if (hasMessageDispatchHooks()) {
    return null;
  }

  const thread = args.thread;
  if (thread.status !== "idle") {
    return null;
  }
  const providerThreadId = getLastProviderThreadId(deps, thread.id);
  if (!providerThreadId) {
    return null;
  }

  const environment = await requireReadyQueuedMessageEnvironment(deps, thread);
  const queuedMessage = toThreadQueuedMessage(args.queuedMessage);
  const senderThreadId = args.queuedMessage.senderThreadId;
  let input = formatQueuedMessageInputForSender({
    input: queuedMessage.content,
    senderThreadId,
  });
  let inputGroups = [input];
  ({ input, inputGroups } = await appendPluginMentionContext({
    input,
    inputGroups,
  }));
  const deferredFirstTurnContext = resolveDeferredFirstTurnContext(
    deps.db,
    thread.id,
  );
  ({ input, inputGroups } = prependDeferredFirstTurnContext(
    { input, inputGroups },
    deferredFirstTurnContext,
  ));
  const payload = sendQueuedMessagePayload(
    { ...queuedMessage, content: input },
    args.mode,
    senderThreadId,
  );
  const initiator: ThreadTurnInitiator =
    senderThreadId === null ? "user" : "agent";
  const execution = await buildExecutionOptions(deps, payload, {
    threadId: thread.id,
  });
  await ensureHostSessionReadyForWork(deps, {
    hostId: environment.hostId,
  });
  const preparedCommand = await prepareTurnSubmitCommandPayload(deps, {
    environment,
    execution,
    input,
    ...(inputGroups.length > 1 ? { inputGroups } : {}),
    permissionEscalation: "ask",
    providerThreadId,
    target: { mode: "start" },
    thread,
  });

  const { activeThread, command } = deps.db.transaction(
    (tx) => {
      if (
        respectsManualStopPause(args) &&
        isThreadQueueAutoSendPaused(tx, thread.id)
      ) {
        throw createQueuedMessageAutoSendPausedError();
      }
      if (deferredFirstTurnContext) {
        requireDeferredFirstTurnContextCurrent(tx, {
          requestSequence: deferredFirstTurnContext.requestSequence,
          threadId: thread.id,
        });
      }
      const consumed = deleteClaimedQueuedThreadMessageInTransaction(
        tx,
        args.queuedMessage,
      );
      if (!consumed) {
        throw createQueuedMessageClaimLostError();
      }
      const request = appendClientTurnEventInTransaction(tx, {
        environmentId: thread.environmentId,
        execution,
        initiator,
        input,
        ...(inputGroups.length > 1 ? { inputGroups } : {}),
        requestMethod: "turn/start",
        senderThreadId,
        source: "tell",
        target: { kind: "new-turn" },
        threadId: thread.id,
        type: "client/turn/requested",
      });
      recordAcceptedPromptHistoryEntry(
        { db: tx },
        {
          thread,
          input,
          initiator,
          target: { kind: "new-turn" },
          requestSequence: request.sequence,
        },
      );
      const command = addRequestIdToTurnSubmitCommandPayload({
        requestId: request.requestId,
        preparedCommand,
      });
      const outcome = applyLoggedThreadLifecycleEventInTransaction(
        { db: tx, logger: deps.logger },
        { event: { type: "run.started" }, threadId: thread.id },
      );
      if (!outcome.applied) {
        throw createQueuedMessageClaimLostError();
      }
      return { activeThread: outcome.thread, command };
    },
    { behavior: "immediate" },
  );

  deps.hub.notifyThread(
    thread.id,
    ["events-appended", "queue-changed", "status-changed"],
    {
      eventTypes: ["client/turn/requested"],
      ...buildThreadStatusChangeMetadata(deps, activeThread),
    },
  );
  startLiveHostCommand(deps, {
    command,
    hostId: environment.hostId,
    timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
    onError: ({ error }) => {
      deps.logger.warn(
        { err: error, threadId: thread.id },
        "Live queued message command failed",
      );
    },
  });
  settleQueueRowDispatched({ row: args.queuedMessage });
  return queuedMessage;
}

/**
 * Delivers a claimed row that is one of core's own system notices.
 *
 * Such a row is not a user dispatch and does not go through the checkpoint:
 * it is an `initiator: "system"` turn with its own taxonomy and its own
 * dispatch path, and the only reason it was on the queue at all is that the
 * queue is where a blocked dispatch waits. Null when the row is an ordinary
 * message, which is every row but these.
 */
async function sendClaimedSystemNotice(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage | null> {
  const claimed = args.queuedMessage;
  if (claimed.systemNotice === null) {
    return null;
  }
  const notice = queuedMessageSystemNoticeSchema.parse(
    JSON.parse(claimed.systemNotice),
  );
  const queuedMessage = toThreadQueuedMessage(claimed);
  const delivered = await deliverParentSystemMessage(deps, {
    input: queuedMessage.content,
    parentThread: args.thread,
    systemMessageKind: notice.kind,
    systemMessageSubject: notice.subject,
  });
  if (!delivered) {
    // The thread changed under the drain. Leave the row claimed-and-released
    // by the caller's error path rather than consuming a notice nobody got.
    throw createQueuedMessageClaimLostError();
  }
  const consumed = deps.db.transaction(
    (tx) => deleteClaimedQueuedThreadMessageInTransaction(tx, claimed),
    { behavior: "immediate" },
  );
  if (!consumed) {
    throw createQueuedMessageClaimLostError();
  }
  settleQueueRowDispatched({ row: claimed });
  return queuedMessage;
}

/**
 * Re-attempts a claimed row through the dispatch checkpoint.
 *
 * The drain is nothing but a re-attempt: the same checkpoint runs, so a row
 * whose wait cleared but whose thread went busy in the meantime simply queues
 * again on the new reason rather than dispatching into a running turn. The
 * claim the caller already won is handed to the attempt, which either consumes
 * it inside the dispatch transaction (exactly once) or gives it back.
 */
async function sendClaimedQueuedMessageForThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage> {
  const notice = await sendClaimedSystemNotice(deps, args);
  if (notice) {
    return notice;
  }
  const sent = await withThreadSendGuard(args.thread.id, () =>
    sendClaimedQueuedMessageForIdleProviderThread(deps, args),
  );
  if (sent) {
    return sent;
  }

  const queuedMessage = toThreadQueuedMessage(args.queuedMessage);
  const outcome = await attemptDispatch(deps, {
    thread: args.thread,
    payload: sendQueuedMessagePayload(
      queuedMessage,
      args.mode,
      args.queuedMessage.senderThreadId,
    ),
    source: {
      kind: "drain",
      claimed: args.queuedMessage,
      respectManualStopPause: respectsManualStopPause(args),
      sendNow: args.sendNow,
    },
    queuePayload: queuedMessage.payload,
    pluginSubmission: null,
    ...(queuedMessage.payload.kind === "retry"
      ? {
          retryOf: {
            requestId: queuedMessage.payload.retryOfTurnRequestId,
            attempt: queuedMessage.payload.attempt,
          },
        }
      : {}),
    origin: null,
    originPluginId: null,
    startedOnBehalfOf: null,
    trigger: "auto-dispatch",
  });
  if (
    args.sendNow &&
    args.mode !== "steer" &&
    outcome.kind === "queued" &&
    outcome.entry.waitingOn?.kind !== "stopping"
  ) {
    // "Send now" overrides every plugin wait and the row's own schedule, but
    // not a core wait — those guard invariants rather than express a policy.
    // The row is back on the queue with its new reason; say so rather than
    // returning a success the caller would read as "it went".
    //
    // `stopping` is the one core wait Send-now does clear, because pressing it
    // is what clears it: the row leaves the manual-stop pause behind and
    // dispatches when the stop lands. Refusing would leave the user no way to
    // express that intent until the stop finished.
    throw new ApiError(
      409,
      "queued_message_still_waiting",
      `This message cannot be sent yet: ${describeCoreWait(outcome.entry.waitingOn)}.`,
    );
  }
  return queuedMessage;
}

/** The user-facing half of a core wait, for a refused "Send now". */
function describeCoreWait(waitingOn: QueuedMessageWaitingOn | null): string {
  switch (waitingOn?.kind) {
    case "provisioning":
      return "the thread's workspace is still being prepared";
    case "host-offline":
      return `the "${waitingOn.hostName}" host is not ready`;
    case "interaction":
      return "the thread is waiting for you to answer a pending interaction";
    case "turn-starting":
      return "the current turn is still starting";
    case "stopping":
      return "the thread is still stopping";
    case "plugin":
      return `it is waiting on the "${waitingOn.pluginId}" plugin`;
    case "time":
    case "thread-busy":
    case undefined:
      return "the thread is already running a turn";
  }
}

export async function sendQueuedMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendQueuedMessageArgs,
): Promise<ThreadQueuedMessage> {
  const sendNow = args.claimPolicy.kind === "explicit-send";
  const queuedMessage = claimQueuedThreadMessageForSend(deps, args);
  if (queuedMessage === null) {
    const existing = getQueuedThreadMessage(deps.db, args.queuedMessageId);
    if (!existing)
      throw new ApiError(404, "invalid_request", "Queued message not found");
    return toThreadQueuedMessage(existing);
  }
  const thread = getThread(deps.db, args.threadId);
  if (
    thread &&
    (isManualCompactionActive(deps, thread) ||
      (args.mode === "auto" &&
        !sendNow &&
        isOrdinaryTurnEndQueuedMessage(queuedMessage) &&
        isThreadQueueAutoSendPaused(deps.db, thread.id)))
  ) {
    releaseClaim(deps, queuedMessage);
    return toThreadQueuedMessage(queuedMessage);
  }
  try {
    return await withActiveQueuedMessageClaim(queuedMessage, () =>
      sendClaimedQueuedMessage(deps, {
        mode: args.mode,
        queuedMessage,
        sendNow,
        threadId: args.threadId,
      }),
    );
  } catch (error) {
    releaseClaim(deps, queuedMessage);
    if (
      isQueuedMessageAutoSendPausedError(error) ||
      error instanceof ThreadContextClearInProgressError
    ) {
      return toThreadQueuedMessage(queuedMessage);
    }
    throw error;
  }
}

export async function sendQueuedMessageNow(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    mode: SendQueuedMessageMode;
    queuedMessageId: string;
    threadId: string;
  },
): Promise<
  | { delivery: "sent" }
  | { delivery: "queued"; queuedMessage: ThreadQueuedMessage }
> {
  await sendQueuedMessage(deps, {
    claimPolicy: { kind: "explicit-send" },
    mode: args.mode,
    queuedMessageId: args.queuedMessageId,
    threadId: args.threadId,
  });
  const remainingQueuedMessage = getQueuedThreadMessage(
    deps.db,
    args.queuedMessageId,
  );
  return remainingQueuedMessage
    ? {
        delivery: "queued",
        queuedMessage: toThreadQueuedMessage(remainingQueuedMessage),
      }
    : { delivery: "sent" };
}

export async function sendNextQueuedMessageIfPresent(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { threadId: string },
): Promise<boolean> {
  const initialThread = getThread(deps.db, args.threadId);
  if (!isQueuedMessageAutoSendCandidate(initialThread)) {
    return false;
  }

  const nextQueuedMessage = claimNextQueuedThreadMessage(
    deps.db,
    deps.hub,
    args.threadId,
    createAutomaticQueuedMessageEligibility(deps, {
      now: Date.now(),
      thread: initialThread,
    }),
  );
  if (!nextQueuedMessage) {
    return false;
  }

  const thread = getThread(deps.db, args.threadId);
  if (
    !isQueuedMessageAutoSendCandidate(thread) ||
    isManualCompactionActive(deps, thread)
  ) {
    releaseClaim(deps, nextQueuedMessage);
    return false;
  }

  try {
    await withActiveQueuedMessageClaim(nextQueuedMessage, () =>
      sendClaimedQueuedMessageForThread(deps, {
        mode: "auto",
        queuedMessage: nextQueuedMessage,
        sendNow: false,
        thread,
      }),
    );
  } catch (error) {
    releaseClaim(deps, nextQueuedMessage);
    if (
      isQueuedMessageClaimLostError(error) ||
      isQueuedMessageAutoSendPausedError(error) ||
      error instanceof ThreadContextClearInProgressError
    ) {
      return false;
    }
    // Nobody is listening to this attempt, so the row itself has to carry what
    // happened — either as a `host-offline` wait it can recover from, or as a
    // failure reason the queued row renders. A host timeout is excluded: the
    // command is still in flight, so the attempt has not failed yet.
    if (!isCommandTimeoutError(error)) {
      recordQueuedMessageDrainFailure(deps, {
        error,
        row: nextQueuedMessage,
        thread,
      });
    }
    throw error;
  }
  return true;
}

export function releaseStaleQueuedMessageDispatchClaims(
  deps: Pick<AppDeps, "db" | "hub">,
  now: number,
): void {
  releaseStaleQueuedMessageClaims(deps.db, deps.hub, {
    claimedBefore: now - STALE_QUEUED_MESSAGE_CLAIM_MS,
    protectedClaimTokens: [...activeQueuedMessageClaimTokens],
  });
}
