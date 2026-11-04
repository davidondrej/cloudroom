import { isDeepStrictEqual } from "node:util";
import {
  listQueuedThreadMessagesWaitingOnKind,
  listRecentNewTurnRequestRows,
  type DbConnection,
} from "@cloudroom/db";
import type {
  PromptInput,
  ResolvedThreadExecutionOptions,
  ThreadQueuedMessage,
} from "@cloudroom/domain";
import { toThreadQueuedMessage } from "./thread-queued-messages.js";
import { formatAgentThreadInput } from "./thread-send.js";

/**
 * A thread that just started turns for the same text this many times in a row,
 * within the window, holds the next copy for a person (issue #264: a script
 * re-sent one message to an idle thread 212 times, a full turn each).
 */
export const REPEATED_MESSAGE_LIMIT = 5;
export const REPEATED_MESSAGE_WINDOW_MS = 15 * 60 * 1000;
/** Loop runs repeat their prompt by design and have their own schedule. */
const LOOP_RUN_PREFIX = "[room-cli automation due:";

function visibleText(input: readonly PromptInput[]): string {
  return input
    .flatMap((block) =>
      block.type === "text" && block.visibility !== "agent-only"
        ? [block.text]
        : [],
    )
    .join("\n");
}

export type RepeatedMessageVerdict =
  | { kind: "none" }
  | { kind: "hold" }
  | { kind: "join"; entry: ThreadQueuedMessage };

/**
 * Hold this message for a person when a same-text card is already held, or
 * the thread's last {@link REPEATED_MESSAGE_LIMIT} turn starts in the window
 * all ran this text from this sender. Pass `execution` to let a fully
 * identical copy join the held card; anything else is held on its own.
 */
export function checkRepeatedMessage(
  db: DbConnection,
  args: {
    input: readonly PromptInput[];
    senderThreadId: string | null;
    threadId: string;
    execution: ResolvedThreadExecutionOptions | null;
  },
): RepeatedMessageVerdict {
  const { execution, senderThreadId, threadId } = args;
  const raw = visibleText(args.input);
  if (raw.trim() === "" || raw.startsWith(LOOP_RUN_PREFIX)) {
    return { kind: "none" };
  }

  const input = JSON.parse(JSON.stringify(args.input)) as unknown;
  const held = listQueuedThreadMessagesWaitingOnKind(db, {
    kind: "repeated-message",
    threadId,
  }).filter(
    (row) =>
      row.senderThreadId === senderThreadId &&
      visibleText(JSON.parse(row.content) as PromptInput[]) === raw,
  );
  const twin = held.find(
    (row) =>
      execution !== null &&
      isDeepStrictEqual(JSON.parse(row.content), input) &&
      row.model === execution.model &&
      row.reasoningLevel === execution.reasoningLevel &&
      row.permissionMode === execution.permissionMode &&
      row.serviceTier === execution.serviceTier,
  );
  if (twin) return { kind: "join", entry: toThreadQueuedMessage(twin) };
  if (held.length > 0) return { kind: "hold" };

  // Requests store the input as the agent saw it, sender tag included.
  const text =
    senderThreadId === null
      ? raw
      : visibleText(
          formatAgentThreadInput({ input: [...args.input], senderThreadId }),
        );
  const recent = listRecentNewTurnRequestRows(db, {
    threadId,
    since: Date.now() - REPEATED_MESSAGE_WINDOW_MS,
    limit: REPEATED_MESSAGE_LIMIT,
  });
  const repeated =
    recent.length === REPEATED_MESSAGE_LIMIT &&
    recent.every((row) => {
      const data = JSON.parse(row.data) as {
        input?: PromptInput[];
        senderThreadId?: string | null;
      };
      return (
        (data.senderThreadId ?? null) === senderThreadId &&
        visibleText(data.input ?? []) === text
      );
    });
  return { kind: repeated ? "hold" : "none" };
}
