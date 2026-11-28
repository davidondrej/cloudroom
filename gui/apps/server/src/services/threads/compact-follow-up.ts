import {
  deleteQueuedThreadMessage,
  getQueuedThreadMessage,
  getStoredTurnRequestEventForTurn,
  hasTurnContextCompaction,
  listQueuedThreadMessages,
  reorderQueuedThreadMessage,
  updateQueuedThreadMessage,
  type QueuedThreadMessageRow,
} from "@cloudroom/db";
import { isStandaloneBuiltinCompactCommand, type PromptInput } from "@cloudroom/domain";
import type { AppDeps } from "../../types.js";
import { parseStoredTurnRequestEvent } from "./thread-events.js";

/**
 * `room-cli thread compact`'s follow-up on a Local thread: a queued row right behind its compaction. When the
 * compaction turn ends it gets a line saying how it went, or goes away after a stop. Held only in memory: after a
 * restart the row still runs, without that line.
 */
const held = new Map<string, string>();

type Deps = Pick<AppDeps, "db" | "hub">;

export function holdCompactFollowUp(threadId: string, queuedMessageId: string): void {
  held.set(threadId, queuedMessageId);
}

/** True while this thread has a queued `/compact`. */
export function hasQueuedCompaction(deps: Pick<AppDeps, "db">, threadId: string): boolean {
  return listQueuedThreadMessages(deps.db, threadId).some((row) =>
    isStandaloneBuiltinCompactCommand(JSON.parse(row.content) as PromptInput[]),
  );
}

/** Moves these queued rows, in this order, ahead of the rest. */
export function queueFirst(deps: Deps, threadId: string, ids: string[]): void {
  ids.forEach((id, index) => {
    const placed = ids.slice(0, index + 1);
    const next = listQueuedThreadMessages(deps.db, threadId).find((row) => !placed.includes(row.id));
    reorderQueuedThreadMessage({
      db: deps.db,
      notifier: deps.hub,
      threadId,
      queuedMessageId: id,
      previousQueuedMessageId: ids[index - 1] ?? null,
      nextQueuedMessageId: next?.id ?? null,
    });
  });
}

/** When a compaction turn ends: the follow-up says how it went, or goes after a stop. True when it is ready to send. */
export function settleCompactFollowUp(
  deps: Deps,
  args: { threadId: string; turnId: string; status: string; error?: string },
): boolean {
  const id = held.get(args.threadId);
  if (id === undefined) return false;
  const request = getStoredTurnRequestEventForTurn(deps.db, { threadId: args.threadId, turnId: args.turnId });
  if (!request || !isStandaloneBuiltinCompactCommand(parseStoredTurnRequestEvent(request).input)) return false;
  held.delete(args.threadId);
  const row = getQueuedThreadMessage(deps.db, id);
  if (!row || row.threadId !== args.threadId) return false;
  if (args.status === "interrupted") {
    deleteQueuedThreadMessage(deps.db, deps.hub, id);
    return false;
  }
  // Codex 0.149 reports only a finished contextCompaction item, no `thread/compacted` (#2424).
  const compacted = hasTurnContextCompaction(deps.db, args);
  tellFollowUp(
    deps,
    row,
    compacted
      ? "Your context was compacted."
      : failed(args.error ?? "the agent didn't compact it"),
  );
  return true;
}

/** The agent refused the compaction, say because a Goal began its next turn first, so it never runs (#2640). */
export function failRefusedCompactFollowUp(
  deps: Deps,
  args: { threadId: string; error: string },
): void {
  const id = held.get(args.threadId);
  // A queued compaction still to come is the one its follow-up waits for.
  if (id === undefined || hasQueuedCompaction(deps, args.threadId)) return;
  held.delete(args.threadId);
  const row = getQueuedThreadMessage(deps.db, id);
  if (row?.threadId === args.threadId)
    tellFollowUp(deps, row, failed(args.error));
}

const failed = (error: string) =>
  `Context compaction failed: ${error}. Your context is unchanged.`;

function tellFollowUp(
  deps: Deps,
  row: QueuedThreadMessageRow,
  outcome: string,
): void {
  const [first, ...rest] = JSON.parse(row.content) as PromptInput[];
  if (first?.type !== "text") return;
  const prefix = `${outcome}\n\n`;
  const mentions = first.mentions.map((m) => ({ ...m, start: m.start + prefix.length, end: m.end + prefix.length }));
  updateQueuedThreadMessage(deps.db, deps.hub, {
    id: row.id,
    threadId: row.threadId,
    expectedUpdatedAt: row.updatedAt,
    content: [{ ...first, text: prefix + first.text, mentions }, ...rest],
  });
}
