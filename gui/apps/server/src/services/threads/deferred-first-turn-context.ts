import {
  findStoredEventRow,
  getLastStoredTurnRequestEvent,
  getLatestCompletedThreadContextClearSequence,
  getThread,
} from "@cloudroom/db";
import type { DbQueryConnection } from "@cloudroom/db";
import {
  THREAD_TELEPORT_LOCAL_OPERATION,
  type PromptInput,
  type Thread,
} from "@cloudroom/domain";
import { ApiError } from "../../errors.js";
import { parseStoredTurnRequestEvent } from "./thread-events.js";
import { pendingHarnessSwitchSeed } from "./thread-transcript.js";
import {
  pendingOperationNote,
  pendingWorktreeMoveNote,
} from "./thread-worktree-move.js";

export interface DeferredFirstTurnContext {
  input: PromptInput[];
  requestSequence: number;
  /** The retry chain of the request this was saved on (its original request id). */
  retryChainRequestId?: string;
}

export interface PromptWithGroups {
  input: PromptInput[];
  inputGroups?: PromptInput[][];
}

export interface GroupedPrompt {
  input: PromptInput[];
  inputGroups: PromptInput[][];
}

export function getLeadingAgentOnlyInput(input: PromptInput[]): PromptInput[] {
  const visibleInputIndex = input.findIndex(
    (item) => item.visibility !== "agent-only",
  );
  return input.slice(
    0,
    visibleInputIndex === -1 ? input.length : visibleInputIndex,
  );
}

/** Agent-only input the next turn must carry: the newest of a spawn/retry seed and a harness switch seed, then a failed
 *  worktree move's note and a Teleport to Local note, unless context was cleared after them. `command`: the turn is a
 *  command such as /compact, which never carries those notes, so they wait for the next message (#1818). */
export function resolveDeferredFirstTurnContext(
  db: DbQueryConnection,
  thread: Pick<Thread, "id" | "executionTarget">,
  retryOfRequestId?: string,
  command = false,
): DeferredFirstTurnContext | null {
  const threadId = thread.id;
  const cleared =
    getLatestCompletedThreadContextClearSequence(db, { threadId }) ?? 0;
  const newest =
    [spawnSeedContext(db, threadId), pendingHarnessSwitchSeed(db, threadId)]
      .filter(
        (context): context is DeferredFirstTurnContext =>
          context !== null && context.requestSequence > cleared,
      )
      .sort((a, b) => b.requestSequence - a.requestSequence)[0] ?? null;
  // A retry re-sends its failed request's input, which already holds what that request carried (#1153).
  const seed =
    retryOfRequestId !== undefined &&
    newest?.retryChainRequestId === retryOfRequestId
      ? null
      : newest;
  // A failed request that carried a note already holds it, in its retry's input or in the seed saved from it.
  const unsent = (note: DeferredFirstTurnContext | null) => {
    const carried = note?.retryChainRequestId;
    return note &&
      (carried === undefined ||
        (carried !== retryOfRequestId && carried !== seed?.retryChainRequestId))
      ? note
      : null;
  };
  // Cloud threads can't move into a worktree or need a Teleport to Local note, so they skip these lookups.
  const notes =
    thread.executionTarget === "cloud" || command
      ? []
      : [
          pendingWorktreeMoveNote(db, threadId, cleared),
          pendingOperationNote(
            db,
            threadId,
            cleared,
            THREAD_TELEPORT_LOCAL_OPERATION,
          ),
        ].map(unsent);
  const contexts = [seed, ...notes].filter(
    (context): context is DeferredFirstTurnContext => context !== null,
  );
  if (contexts.length < 2) return contexts[0] ?? null;
  return {
    input: contexts.flatMap((context) => context.input),
    requestSequence: Math.max(
      ...contexts.map((context) => context.requestSequence),
    ),
  };
}

function spawnSeedContext(
  db: DbQueryConnection,
  threadId: string,
): DeferredFirstTurnContext | null {
  const row = getLastStoredTurnRequestEvent(db, threadId);
  if (!row || row.type !== "client/turn/requested") {
    return null;
  }
  const request = parseStoredTurnRequestEvent(row);
  const isSeedRequest =
    request.source === "spawn" &&
    request.request.method === "thread/start" &&
    request.initiator === "agent" &&
    request.senderThreadId !== null &&
    request.target.kind === "thread-start";
  const isUndeliveredRetry =
    request.source === "tell" &&
    request.request.method === "turn/start" &&
    request.target.kind === "new-turn" &&
    getThread(db, threadId)?.status === "error";
  // A failed retry saves the user's own message as agent-only. Never carry a skill or
  // command they picked: one refused skill would refuse every later message (#1038).
  const leadingInput = getLeadingAgentOnlyInput(request.input).filter(
    (part) =>
      part.type !== "text" ||
      !part.mentions.some(({ resource }) => resource.kind === "command"),
  );
  const context = leadingInput.length > 0 ? leadingInput : null;
  if (
    context === null ||
    (!isSeedRequest && !isUndeliveredRetry) ||
    findStoredEventRow(db, {
      afterSequence: row.sequence,
      threadId,
      type: "turn/started",
    }) !== null
  ) {
    return null;
  }
  return {
    input: context,
    requestSequence: row.sequence,
    retryChainRequestId: request.retryOfRequestId ?? request.requestId,
  };
}

export function prependDeferredFirstTurnContext(
  prompt: GroupedPrompt,
  context: DeferredFirstTurnContext | null,
): GroupedPrompt;
export function prependDeferredFirstTurnContext(
  prompt: PromptWithGroups,
  context: DeferredFirstTurnContext | null,
): PromptWithGroups;
export function prependDeferredFirstTurnContext(
  prompt: PromptWithGroups,
  context: DeferredFirstTurnContext | null,
): PromptWithGroups {
  if (!context) {
    return prompt;
  }
  return {
    input: [...context.input, ...prompt.input],
    ...(prompt.inputGroups !== undefined
      ? {
          inputGroups: [
            [...context.input, ...prompt.inputGroups[0]!],
            ...prompt.inputGroups.slice(1),
          ],
        }
      : {}),
  };
}

export function requireDeferredFirstTurnContextCurrent(
  db: DbQueryConnection,
  args: {
    command: boolean;
    requestSequence: number;
    retryOfRequestId: string | undefined;
    thread: Pick<Thread, "id" | "executionTarget">;
  },
): void {
  const current = resolveDeferredFirstTurnContext(
    db,
    args.thread,
    args.retryOfRequestId,
    args.command,
  );
  if (current?.requestSequence === args.requestSequence) {
    return;
  }
  throw new ApiError(
    409,
    "invalid_request",
    "Thread already accepted its first real turn",
  );
}
