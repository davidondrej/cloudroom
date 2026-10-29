import {
  createEventId,
  getEnvironment,
  getLatestCompletedThreadContextClearSequence,
  getThread,
  setThreadExecutionOverride,
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
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import {
  cloudExecution,
  cloudroom,
  isCloudThread,
} from "../cloudroom/commands.js";
import { teleportBlocked } from "../cloudroom/store.js";
import { storeAttachment } from "../projects/attachments.js";
import { withThreadContextClearGuard } from "./thread-context-mutation-guard.js";
import { appendThreadEventInTransaction } from "./thread-events.js";
import { resolveHarnessSwitchOverride } from "./thread-execution-override.js";
import { stopThreadForCurrentState } from "./thread-lifecycle.js";
import {
  threadMessages,
  transcriptMarkdown,
  type ThreadMessage,
} from "./thread-transcript.js";

export interface HarnessSwitch {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel | null;
}

const HISTORY_FILE = "conversation-history.md";
// The file stays far below the 100 MB attachment limit; the inline tail stays well inside Cloud's 256 KB message limit.
const FILE_CHARS = 4_000_000;
const TAIL_CHARS = 6_000;

/**
 * Moves a thread to another harness or model in place (ADR 0211). Nothing changes if the new harness can't start.
 * The next turn starts a fresh native session that gets the earlier conversation as hidden context.
 */
export async function switchThreadHarness(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
  target: HarnessSwitch,
): Promise<void> {
  const from = await withThreadContextClearGuard(threadId, async () => {
    const thread = requireSwitchableThread(deps, threadId);
    const prepare = async () => {
      const seed = await historySeed(
        deps,
        thread,
        `[Cloudroom] This conversation started with another agent (${thread.providerId}). You are now continuing it as ${target.providerId}.`,
      );
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
            },
          },
        });
      };
    };
    if (isCloudThread(thread)) {
      await cloudroom(deps).switchHarness(thread, target, prepare);
      return thread;
    }
    const override = await resolveHarnessSwitchOverride(deps, thread, target);
    const environment = thread.environmentId
      ? getEnvironment(deps.db, thread.environmentId)
      : null;
    // Release the old harness's process before the thread points at the new one.
    await stopThreadForCurrentState(deps, thread, environment ?? null);
    const record = await prepare();
    deps.db.transaction((tx) => {
      updateThread(tx, deps.hub, threadId, { providerId: target.providerId });
      setThreadExecutionOverride(tx, { threadId, ...override });
      record(tx);
    });
    return thread;
  });
  deps.hub.notifyThread(threadId, ["execution-options-changed"], {
    projectId: from.projectId,
  });
  deps.telemetry.capture({
    name: "harness_switched",
    properties: {
      execution: isCloudThread(from) ? cloudExecution(deps, threadId) : "local",
      from: from.providerId,
      to: target.providerId,
    },
  });
}

function requireSwitchableThread(
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
