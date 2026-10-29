import {
  createPromptHistoryEntry,
  listPromptHistoryCommandUses,
  listQueuedThreadMessages,
  listStoredProjectPromptHistoryRows,
  listStoredThreadPromptHistoryRows,
  type DbQueryConnection,
  type QueuedThreadMessageRow,
  type StoredPromptHistoryEntryRow,
} from "@cloudroom/db";
import {
  promptInputSchema,
  takeVisiblePromptHistoryEntries,
  type PromptHistoryEntry,
  type PromptHistoryScope,
  type Thread,
  type ThreadTurnInitiator,
  type TurnRequestTarget,
} from "@cloudroom/domain";
import { z } from "zod";
import { toThreadQueuedMessage } from "./threads/thread-queued-messages.js";
import type { AppDeps } from "../types.js";

const storedPromptHistoryInputSchema = z.array(promptInputSchema).min(1);
const COMMAND_USAGE_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
// Older uses weigh under 2% of a fresh one, so skip them.
const COMMAND_USAGE_WINDOW_MS = 6 * COMMAND_USAGE_HALF_LIFE_MS;

interface PromptHistoryArgs {
  limit: number;
}

interface ProjectPromptHistoryArgs extends PromptHistoryArgs {
  projectId: string;
}

interface ThreadPromptHistoryArgs extends PromptHistoryArgs {
  threadId: string;
}

type PromptHistoryServiceDeps = Pick<AppDeps, "db">;
type PromptHistoryEntryInput = PromptHistoryEntry["input"];
type PromptHistoryScopeThread = Pick<Thread, "parentThreadId">;
type PromptHistoryRecordThread = Pick<
  Thread,
  "id" | "parentThreadId" | "projectId"
>;

interface PromptHistoryRecordDeps {
  db: DbQueryConnection;
}

type InternalPromptHistoryEntryState = "accepted" | "queued";

interface InternalPromptHistoryEntry extends PromptHistoryEntry {
  state: InternalPromptHistoryEntryState;
}

interface ResolveAcceptedPromptHistoryScopeArgs {
  initiator: ThreadTurnInitiator;
  target: TurnRequestTarget;
  thread: PromptHistoryScopeThread;
}

interface RecordAcceptedPromptHistoryEntryArgs {
  initiator: ThreadTurnInitiator;
  input: PromptHistoryEntryInput;
  requestSequence: number;
  target: TurnRequestTarget;
  thread: PromptHistoryRecordThread;
}

interface BuildPromptHistoryEntriesArgs<TRow> {
  buildEntry: (row: TRow) => InternalPromptHistoryEntry;
  rows: readonly TRow[];
}

function parseStoredPromptHistoryInput(
  row: StoredPromptHistoryEntryRow,
): PromptHistoryEntryInput {
  const input = JSON.parse(row.input);
  return storedPromptHistoryInputSchema.parse(input);
}

function buildAcceptedPromptHistoryEntry(
  row: StoredPromptHistoryEntryRow,
): InternalPromptHistoryEntry {
  return {
    id: row.id,
    createdAt: row.createdAt,
    input: parseStoredPromptHistoryInput(row),
    state: "accepted",
  };
}

function buildQueuedPromptHistoryEntry(
  row: QueuedThreadMessageRow,
): InternalPromptHistoryEntry {
  const queuedMessage = toThreadQueuedMessage(row);
  return {
    id: `queued-message:${queuedMessage.id}`,
    createdAt: queuedMessage.createdAt,
    input: queuedMessage.content,
    state: "queued",
  };
}

function comparePromptHistoryEntries(
  left: InternalPromptHistoryEntry,
  right: InternalPromptHistoryEntry,
): number {
  if (left.createdAt !== right.createdAt) {
    return right.createdAt - left.createdAt;
  }
  if (left.state !== right.state) {
    return left.state === "queued" ? -1 : 1;
  }
  return right.id.localeCompare(left.id);
}

function toPromptHistoryEntry(
  entry: InternalPromptHistoryEntry,
): PromptHistoryEntry {
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    input: entry.input,
  };
}

function buildPromptHistoryEntries<TRow>({
  buildEntry,
  rows,
}: BuildPromptHistoryEntriesArgs<TRow>): InternalPromptHistoryEntry[] {
  const entries: InternalPromptHistoryEntry[] = [];

  for (const row of rows) {
    try {
      entries.push(buildEntry(row));
    } catch {
      continue;
    }
  }

  return entries;
}

function resolveAcceptedPromptHistoryScope(
  args: ResolveAcceptedPromptHistoryScopeArgs,
): PromptHistoryScope | null {
  if (args.initiator !== "user") {
    return null;
  }

  if (args.target.kind !== "thread-start") {
    return "thread";
  }

  if (args.thread.parentThreadId !== null) {
    return null;
  }

  return "project";
}

function buildVisibleThreadPromptHistory(
  queuedEntries: readonly InternalPromptHistoryEntry[],
  acceptedEntries: readonly InternalPromptHistoryEntry[],
  limit: number,
): PromptHistoryEntry[] {
  const mergedEntries = [...queuedEntries, ...acceptedEntries].sort(
    comparePromptHistoryEntries,
  );
  return takeVisiblePromptHistoryEntries({
    entries: mergedEntries,
    limit,
  }).map(toPromptHistoryEntry);
}

export function listProjectPromptHistory(
  deps: PromptHistoryServiceDeps,
  args: ProjectPromptHistoryArgs,
): PromptHistoryEntry[] {
  const acceptedEntries = buildPromptHistoryEntries({
    rows: listStoredProjectPromptHistoryRows(deps.db, {
      projectId: args.projectId,
      limit: args.limit,
    }),
    buildEntry: buildAcceptedPromptHistoryEntry,
  });

  return takeVisiblePromptHistoryEntries({
    entries: acceptedEntries,
    limit: args.limit,
  }).map(toPromptHistoryEntry);
}

export function listThreadPromptHistory(
  deps: PromptHistoryServiceDeps,
  args: ThreadPromptHistoryArgs,
): PromptHistoryEntry[] {
  const queuedEntries = buildPromptHistoryEntries({
    rows: listQueuedThreadMessages(deps.db, args.threadId),
    buildEntry: buildQueuedPromptHistoryEntry,
  });
  const acceptedEntries = buildPromptHistoryEntries({
    rows: listStoredThreadPromptHistoryRows(deps.db, {
      threadId: args.threadId,
      limit: args.limit,
    }),
    buildEntry: buildAcceptedPromptHistoryEntry,
  });

  return buildVisibleThreadPromptHistory(
    queuedEntries,
    acceptedEntries,
    args.limit,
  );
}

export function recordAcceptedPromptHistoryEntry(
  deps: PromptHistoryRecordDeps,
  args: RecordAcceptedPromptHistoryEntryArgs,
): boolean {
  const input = args.input.filter((item) => item.visibility !== "agent-only");
  if (input.length === 0) {
    return false;
  }
  const scope = resolveAcceptedPromptHistoryScope({
    initiator: args.initiator,
    target: args.target,
    thread: args.thread,
  });
  if (scope === null) {
    return false;
  }

  createPromptHistoryEntry(deps.db, {
    projectId: args.thread.projectId,
    threadId: args.thread.id,
    scope,
    requestSequence: args.requestSequence,
    input,
  });
  return true;
}

/** Recency-weighted uses per command or skill name: each use halves in weight every 14 days. */
export function listCommandUsage(
  deps: PromptHistoryServiceDeps,
  now = Date.now(),
): Map<string, number> {
  const usage = new Map<string, number>();
  const uses = listPromptHistoryCommandUses(
    deps.db,
    now - COMMAND_USAGE_WINDOW_MS,
  );
  for (const { name, createdAt } of uses) {
    if (typeof name !== "string") continue;
    const weight = 0.5 ** ((now - createdAt) / COMMAND_USAGE_HALF_LIFE_MS);
    usage.set(name, (usage.get(name) ?? 0) + weight);
  }
  return usage;
}
