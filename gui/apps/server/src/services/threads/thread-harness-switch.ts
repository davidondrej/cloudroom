import {
  createEventId,
  deleteQueuedThreadMessage,
  findStoredEventRow,
  getEnvironment,
  getLatestCompletedThreadContextClearSequence,
  getThread,
  setThreadExecutionOverride,
  threadHasProviderSession,
  updateThread,
  type DbTransaction,
} from "@cloudroom/db";
import {
  THREAD_HARNESS_SWITCH_OPERATION,
  threadScope,
  type PromptInput,
  type ReasoningLevel,
  type Thread,
} from "@cloudroom/domain";
import type {
  RetryTurnRequest,
  RetryTurnResponse,
} from "@cloudroom/server-contract";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import {
  cloudExecution,
  cloudroom,
  isCloudThread,
} from "../cloudroom/commands.js";
import { teleportBlocked } from "../cloudroom/store.js";
import { emitPluginMessageCancelled } from "../plugins/plugin-thread-events.js";
import { storeAttachment } from "../projects/attachments.js";
import { resolveDeferredFirstTurnContext } from "./deferred-first-turn-context.js";
import { withThreadContextClearGuard } from "./thread-context-mutation-guard.js";
import {
  appendThreadEvent,
  appendThreadEventInTransaction,
  getLastProviderThreadId,
} from "./thread-events.js";
import { resolveHarnessSwitchOverride } from "./thread-execution-override.js";
import { stopThreadForCurrentState } from "./thread-lifecycle.js";
import { acceptThreadSendRequest } from "./thread-send-request.js";
import { cancelRetriesForExplicitStop, retryFailedTurn } from "./turn-retry.js";
import { loadFailedTurn, type FailedTurnRecord } from "./turn-failed.js";
import {
  MISSING_SESSION_ERROR,
  sessionMayHoldHistory,
  threadMessages,
  transcriptMarkdown,
  type ThreadMessage,
} from "./thread-transcript.js";

export interface HarnessSwitch {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel | null;
}

/** What `resend` did. `starting`: sent, but the host hasn't confirmed the turn yet. */
export type HarnessSwitchResend =
  | { delivery: "started" | "starting" | "queued" }
  | { delivery: "failed"; error: string };

// A resend waits for the host to start the new turn, but the whole switch replies
// within 20 s: the Connect relay gives phone and Mac-to-Mac requests 30 s.
const RESEND_REPLY_WITHIN_MS = 20_000;

const CONTINUE_TEXT =
  "[Cloudroom] Continue the conversation: answer the user's last message if it has no reply yet, or finish the task that was in progress.";
const HISTORY_FILE = "conversation-history.md";
// The file stays far below the 100 MB attachment limit; the inline tail stays well inside Cloud's 256 KB message limit.
const FILE_CHARS = 4_000_000;
const TAIL_CHARS = 6_000;

/**
 * Moves a thread to another harness or model in place (ADR 0211). Nothing changes if the new harness can't start.
 * The next turn starts a fresh native session that gets the earlier conversation as hidden context.
 * With `resend`, that turn starts right away, and the result says whether it did.
 */
export async function switchThreadHarness(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
  target: HarnessSwitch,
  options: { resend?: boolean } = {},
): Promise<HarnessSwitchResend | null> {
  const replyBy = Date.now() + RESEND_REPLY_WITHIN_MS;
  const run: SwitchRun = { cloud: false, switched: false, late: false };
  const work = switchThenResend(deps, threadId, target, options, replyBy, run);
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    work,
    new Promise<"late">((resolve) => {
      timer = setTimeout(resolve, replyBy - Date.now(), "late");
    }),
  ]).finally(() => clearTimeout(timer));
  if (result !== "late") return result;
  // Cloud's switch can't be cancelled midway, and a finished switch without resend is done.
  if (run.cloud || (run.switched && !options.resend)) return work;
  const status = run.switched
    ? getThread(deps.db, threadId)?.status
    : undefined;
  if (status !== undefined && status !== "idle" && status !== "error") {
    return { delivery: "starting" };
  }
  // Whatever hasn't switched or sent yet now never will, so the answer stays true.
  run.late = true;
  if (run.switched) return { delivery: "failed", error: "it took too long" };
  throw switchTimeout();
}

/** Once `late`, the reply went out; the work still running must neither switch nor send. */
interface SwitchRun {
  cloud: boolean;
  switched: boolean;
  late: boolean;
}

function switchTimeout(): ApiError {
  return new ApiError(
    504,
    "harness_switch_timeout",
    "The switch took too long, so the thread stays on its current agent. Try again.",
  );
}

async function switchThenResend(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
  target: HarnessSwitch,
  options: { resend?: boolean },
  replyBy: number,
  run: SwitchRun,
): Promise<HarnessSwitchResend | null> {
  const from = await withThreadContextClearGuard(threadId, async () => {
    if (run.late) throw switchTimeout();
    const thread = requireSwitchableThread(deps, threadId);
    run.cloud = isCloudThread(thread);
    const unstartedLocalFork =
      !run.cloud &&
      thread.originKind === "fork" &&
      !threadHasProviderSession(deps.db, threadId);
    // A Core that switches the conversation itself builds the history (#237): no seed then.
    const prepare = async (seeded = true) => {
      const seed = !seeded ? [] : await historySeed(
        deps,
        thread,
        `[Cloudroom] This conversation started with another agent (${thread.providerId}). You are now continuing it as ${target.providerId}.`,
      );
      if (unstartedLocalFork && seed.length === 0) {
        return () => {};
      }
      return (tx: DbTransaction) => {
        appendThreadEventInTransaction(tx, {
          threadId,
          environmentId: thread.environmentId,
          type: "system/operation",
          scope: threadScope(),
          data: {
            operation: THREAD_HARNESS_SWITCH_OPERATION,
            operationId: createEventId(),
            status: "completed",
            message: `Switched from ${thread.providerId} to ${target.providerId} (${target.model}).`,
            metadata: {
              from: thread.providerId,
              to: target.providerId,
              model: target.model,
              seed,
              // A plan-limit card shows the new agent picking up only after a switch that continues right away.
              resend: options.resend === true,
            },
          },
        });
      };
    };
    if (run.cloud) {
      await cloudroom(deps).switchHarness(thread, target, prepare);
      return thread;
    }
    const override = await resolveHarnessSwitchOverride(deps, thread, target);
    if (run.late) throw switchTimeout();
    requireReady(deps, thread, target);
    const environment = thread.environmentId
      ? getEnvironment(deps.db, thread.environmentId)
      : null;
    // Release the old harness's process before the thread points at the new one,
    // even mid-turn: a failed turn can leave the host running one, which refuses the new agent (#856).
    // An unstarted idle fresh side chat never launched a provider process, so it skips the stop round-trip.
    if (!(unstartedLocalFork && thread.status === "idle")) {
      await stopThreadForCurrentState(deps, thread, environment ?? null, {
        releaseMidTurn: true,
      }).catch((error: unknown) => {
        throw new ApiError(
          error instanceof ApiError ? error.status : 502,
          "harness_switch_stop_failed",
          `Couldn't stop ${thread.providerId}, so the thread stays on it: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    const record = await prepare();
    if (run.late) throw switchTimeout();
    deps.db.transaction((tx) => {
      updateThread(tx, deps.hub, threadId, { providerId: target.providerId });
      setThreadExecutionOverride(tx, { threadId, ...override });
      record(tx);
    });
    run.switched = true;
    return thread;
  });
  // A queued retry replays the old harness's model, so it can only fail now.
  cancelRetriesForExplicitStop(deps, threadId, { chosen: false });
  deps.hub.notifyThread(threadId, ["execution-options-changed"], {
    projectId: from.projectId,
  });
  deps.telemetry.capture({
    name: "harness_switched",
    properties: {
      execution: isCloudThread(from) ? cloudExecution(deps, threadId) : "local",
      from: from.providerId,
      to: target.providerId,
      resend: options.resend === true,
    },
  });
  return options.resend
    ? resendAfterSwitch(deps, threadId, replyBy, () => run.late)
    : null;
}

/** An agent that can't build its launch options (say Cloudroom Agent, signed out) says why before the current one stops. */
function requireReady(
  deps: LoggedPendingInteractionWorkSessionDeps,
  thread: Thread,
  target: HarnessSwitch,
): void {
  try {
    deps.providerRegistry.get(target.providerId)?.deriveProviderOptions({
      threadId: thread.id,
      projectId: thread.projectId,
      model: target.model,
      permissionMode: "full",
    });
  } catch (error) {
    throw new ApiError(
      409,
      "harness_switch_not_ready",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** A hidden nudge, sent like any message so it carries the earlier conversation. */
async function resendAfterSwitch(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
  replyBy = Date.now() + RESEND_REPLY_WITHIN_MS,
  isLate = () => false,
): Promise<HarnessSwitchResend> {
  const thread = getThread(deps.db, threadId);
  if (!thread) throw new ApiError(404, "thread_not_found", "Thread not found");
  const nudge: PromptInput = {
    type: "text",
    text: CONTINUE_TEXT,
    mentions: [],
    visibility: "agent-only",
  };
  // Cloud adds the earlier conversation only to messages that don't start hidden.
  const seed = isCloudThread(thread)
    ? (resolveDeferredFirstTurnContext(deps.db, thread)?.input ?? [])
    : [];
  let settle: (error: Error | null) => void = () => {};
  const settled = new Promise<Error | null>((resolve) => (settle = resolve));
  const sent = await acceptThreadSendRequest(deps, {
    thread,
    payload: { input: [...seed, nudge], mode: "queue-if-active" },
    onStartSettled: settle,
    beforeDispatch: () => {
      if (isLate())
        throw new Error("Resend cancelled after the switch replied");
    },
  });
  if (sent.delivery === "queued") {
    if (!isLate()) return { delivery: "queued" };
    if (deleteQueuedThreadMessage(deps.db, deps.hub, sent.queuedMessage.id)) {
      emitPluginMessageCancelled(sent.queuedMessage);
    }
    return { delivery: "failed", error: "it took too long" };
  }
  if (isCloudThread(thread)) return { delivery: "started" };
  // Local hands the turn to the host after replying "sent"; wait for its answer (#856).
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    settled,
    new Promise<"starting">((resolve) => {
      timer = setTimeout(
        resolve,
        Math.max(0, replyBy - Date.now()),
        "starting",
      );
    }),
  ]).finally(() => clearTimeout(timer));
  if (result === "starting") return { delivery: "starting" };
  return result
    ? { delivery: "failed", error: result.message }
    : { delivery: "started" };
}

/**
 * Codex saves a session only once a turn starts, so it can't resume one whose first turn never started: "no rollout
 * found" (#335). The thread then moves to a fresh session that gets the conversation so far, as a switch does, and
 * its failed turn runs again there. `automatic` does this only when nothing is lost; a session that may hold history
 * the transcript lacks waits for the user's "Start fresh with the history". Nothing is written until the failed turn
 * is the latest, failed for this reason on `session`, and its retry is reserved.
 */
export async function continueInFreshSession(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
  session: string | null,
  request: RetryTurnRequest,
  automatic = false,
): Promise<RetryTurnResponse> {
  const thread = getThread(deps.db, threadId);
  if (!thread) throw new ApiError(404, "thread_not_found", "Thread not found");
  if (isCloudThread(thread)) {
    throw new ApiError(
      409,
      "invalid_request",
      "Cloud threads can't start fresh this way.",
    );
  }
  const refuse = (message: string) =>
    new ApiError(409, "no_failed_turn", message);
  // A newer send or recovery may move on while the history file is written; it wins.
  const unchanged = (failed: FailedTurnRecord) => {
    const current = getThread(deps.db, threadId);
    const rejection = findStoredEventRow(deps.db, {
      threadId,
      type: "client/turn/rejected",
      afterSequence: failed.requestSequence,
    });
    if (
      session === null ||
      current?.status !== "error" ||
      current.providerId !== "codex" ||
      current.archivedAt !== null ||
      current.deletedAt !== null ||
      teleportBlocked(deps.db, threadId) ||
      loadFailedTurn(deps.db, threadId)?.requestSequence !==
        failed.requestSequence ||
      getLastProviderThreadId(deps, threadId) !== session
    ) {
      throw refuse(
        "This thread has moved on, so there's nothing to start fresh.",
      );
    }
    const reason = rejection
      ? (JSON.parse(rejection.data) as { message?: unknown }).message
      : null;
    if (typeof reason !== "string" || !MISSING_SESSION_ERROR.test(reason)) {
      throw refuse("This thread's last failure wasn't a lost session.");
    }
    return current;
  };
  return retryFailedTurn(deps, {
    thread,
    request,
    prepare: (failed) =>
      withThreadContextClearGuard(
        threadId,
        async () => {
          const before = unchanged(failed);
          if (
            automatic &&
            session !== null &&
            sessionMayHoldHistory(deps.db, before, session)
          ) {
            throw refuse(
              "This session may hold history, so it waits for Start fresh.",
            );
          }
          const seed = await historySeed(
            deps,
            before,
            `[Cloudroom] ${before.providerId} couldn't reopen this conversation's session, so you continue it in a new one.`,
          );
          const current = unchanged(failed);
          appendThreadEvent(deps, {
            threadId,
            environmentId: current.environmentId,
            type: "system/operation",
            scope: threadScope(),
            data: {
              operation: THREAD_HARNESS_SWITCH_OPERATION,
              operationId: createEventId(),
              status: "completed",
              message: `Continued in a new ${current.providerId} session.`,
              metadata: {
                from: current.providerId,
                to: current.providerId,
                seed,
              },
            },
          });
        },
        "This thread is starting a new session. Try again in a moment.",
      ),
  });
}

export function requireSwitchableThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
): Thread {
  const thread = getThread(deps.db, threadId);
  if (!thread) throw new ApiError(404, "thread_not_found", "Thread not found");
  if (thread.archivedAt !== null || thread.deletedAt !== null) {
    throw new ApiError(
      409,
      "thread_not_writable",
      "Thread is archived or deleted",
    );
  }
  if (thread.status !== "idle" && thread.status !== "error") {
    throw new ApiError(
      409,
      "thread_busy",
      "Wait until the agent finishes, then switch.",
    );
  }
  if (deps.pendingInteractions.hasPendingThreadInteraction(thread.id)) {
    throw new ApiError(
      409,
      "awaiting_user_interaction",
      "Answer the agent's question, then switch.",
    );
  }
  if (teleportBlocked(deps.db, thread.id)) {
    throw new ApiError(
      409,
      "teleport_in_progress",
      "Wait for Teleport to finish, then switch.",
    );
  }
  return thread;
}

export async function historySeed(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "config" | "db">,
  thread: Thread,
  intro: string,
  projectId = thread.projectId,
): Promise<PromptInput[]> {
  const after =
    getLatestCompletedThreadContextClearSequence(deps.db, {
      threadId: thread.id,
    }) ?? undefined;
  return messagesSeed(
    deps.config.dataDir,
    projectId,
    threadMessages(deps.db, thread.id, { after }),
    intro,
  );
}

/** The conversation so far, as hidden input for a fresh session: a short note with the latest messages, plus the full history as a file. */
export async function messagesSeed(
  dataDir: string,
  projectId: string,
  messages: readonly ThreadMessage[],
  intro: string,
): Promise<PromptInput[]> {
  if (messages.length === 0) return [];
  const full = transcriptMarkdown(fit(messages, FILE_CHARS));
  const file = await storeAttachment(
    dataDir,
    projectId,
    new File([`# Conversation so far\n\n${full}\n`], HISTORY_FILE, {
      type: "text/markdown",
    }),
  );
  const tail = transcriptMarkdown(fit(messages, TAIL_CHARS, false));
  return [
    {
      type: "text",
      text: [
        intro,
        `The full conversation so far is in the attached ${HISTORY_FILE}: user messages and agent replies, without tool output. Read it before you reply, treat it as your own history, check the workspace for the current state, and don't redo finished work.`,
        `The latest messages:\n\n${tail}`,
        "The user's new message follows.",
      ].join("\n\n"),
      mentions: [],
      visibility: "agent-only",
    },
    { ...file, visibility: "agent-only" },
  ];
}

/** Keeps the newest messages that fit, plus the first one (the original task) when `keepFirst` is set. */
function fit(
  messages: readonly ThreadMessage[],
  limit: number,
  keepFirst = true,
): ThreadMessage[] {
  const kept: ThreadMessage[] = [];
  let size = keepFirst ? messages[0]!.text.length : 0;
  for (let index = messages.length - 1; index >= (keepFirst ? 1 : 0); index--) {
    const message = messages[index]!;
    if (size + message.text.length > limit) {
      if (kept.length === 0 && !keepFirst)
        kept.unshift({ ...message, text: `…${message.text.slice(-limit)}` });
      break;
    }
    size += message.text.length;
    kept.unshift(message);
  }
  const omitted = messages.length - kept.length - (keepFirst ? 1 : 0);
  const gap: ThreadMessage[] =
    omitted > 0
      ? [{ role: "user", text: `[${omitted} earlier messages left out]` }]
      : [];
  return keepFirst ? [messages[0]!, ...gap, ...kept] : [...gap, ...kept];
}
