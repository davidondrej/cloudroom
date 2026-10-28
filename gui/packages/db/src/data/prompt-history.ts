import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  PROMPT_HISTORY_ENTRY_LIMIT,
  type PromptHistoryScope,
  type PromptInput,
} from "@cloudroom/domain";
import type { DbQueryConnection } from "../connection.js";
import { promptHistoryEntries, threads } from "../schema.js";
import { createPromptHistoryEntryId } from "../ids.js";

export interface StoredPromptHistoryEntryRow {
  createdAt: number;
  id: string;
  input: string;
  requestSequence: number;
  threadId: string;
}

export interface PromptHistoryCommandUseRow {
  createdAt: number;
  name: string;
}

export interface CreatePromptHistoryEntryInput {
  createdAt?: number;
  input: PromptInput[];
  projectId: string;
  requestSequence: number;
  scope: PromptHistoryScope;
  threadId: string;
}

export interface ListStoredPromptHistoryArgs {
  limit: number;
}

export interface ListStoredProjectPromptHistoryArgs
  extends ListStoredPromptHistoryArgs {
  projectId: string;
}

export interface ListStoredThreadPromptHistoryArgs
  extends ListStoredPromptHistoryArgs {
  threadId: string;
}

function rawPromptHistoryRowLimit(limit: number): number {
  return Math.min(
    PROMPT_HISTORY_ENTRY_LIMIT * 2,
    limit + PROMPT_HISTORY_ENTRY_LIMIT,
  );
}

export function createPromptHistoryEntry(
  db: DbQueryConnection,
  input: CreatePromptHistoryEntryInput,
): StoredPromptHistoryEntryRow {
  const createdAt = input.createdAt ?? Date.now();
  return db
    .insert(promptHistoryEntries)
    .values({
      id: createPromptHistoryEntryId(),
      projectId: input.projectId,
      threadId: input.threadId,
      scope: input.scope,
      requestSequence: input.requestSequence,
      input: JSON.stringify(input.input),
      createdAt,
    })
    .returning({
      createdAt: promptHistoryEntries.createdAt,
      id: promptHistoryEntries.id,
      input: promptHistoryEntries.input,
      requestSequence: promptHistoryEntries.requestSequence,
      threadId: promptHistoryEntries.threadId,
    })
    .get();
}

export function listStoredProjectPromptHistoryRows(
  db: DbQueryConnection,
  args: ListStoredProjectPromptHistoryArgs,
): StoredPromptHistoryEntryRow[] {
  return db
    .select({
      createdAt: promptHistoryEntries.createdAt,
      id: promptHistoryEntries.id,
      input: promptHistoryEntries.input,
      requestSequence: promptHistoryEntries.requestSequence,
      threadId: promptHistoryEntries.threadId,
    })
    .from(promptHistoryEntries)
    .innerJoin(threads, eq(threads.id, promptHistoryEntries.threadId))
    .where(
      and(
        eq(promptHistoryEntries.projectId, args.projectId),
        eq(promptHistoryEntries.scope, "project"),
        isNull(threads.deletedAt),
      ),
    )
    .orderBy(
      desc(promptHistoryEntries.createdAt),
      desc(promptHistoryEntries.requestSequence),
      desc(promptHistoryEntries.id),
    )
    .limit(rawPromptHistoryRowLimit(args.limit))
    .all();
}

export function listStoredThreadPromptHistoryRows(
  db: DbQueryConnection,
  args: ListStoredThreadPromptHistoryArgs,
): StoredPromptHistoryEntryRow[] {
  return db
    .select({
      createdAt: promptHistoryEntries.createdAt,
      id: promptHistoryEntries.id,
      input: promptHistoryEntries.input,
      requestSequence: promptHistoryEntries.requestSequence,
      threadId: promptHistoryEntries.threadId,
    })
    .from(promptHistoryEntries)
    .where(
      and(
        eq(promptHistoryEntries.threadId, args.threadId),
        eq(promptHistoryEntries.scope, "thread"),
      ),
    )
    .orderBy(
      desc(promptHistoryEntries.createdAt),
      desc(promptHistoryEntries.requestSequence),
      desc(promptHistoryEntries.id),
    )
    .limit(rawPromptHistoryRowLimit(args.limit))
    .all();
}

/** Every slash command or skill chip in prompts sent since `since`. */
export function listPromptHistoryCommandUses(
  db: DbQueryConnection,
  since: number,
): PromptHistoryCommandUseRow[] {
  return db.all<PromptHistoryCommandUseRow>(sql`
    SELECT
      json_extract(mention.value, '$.resource.name') AS name,
      entry.created_at AS createdAt
    FROM ${promptHistoryEntries} AS entry,
      json_each(entry.input) AS item,
      json_each(item.value, '$.mentions') AS mention
    WHERE entry.created_at >= ${since}
      AND json_extract(mention.value, '$.resource.kind') = 'command'
  `);
}
