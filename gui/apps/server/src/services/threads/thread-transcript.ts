import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import {
  events,
  findStoredEventRow,
  type DbQueryConnection,
} from "@cloudroom/db";
import {
  THREAD_HARNESS_SWITCH_OPERATION,
  THREAD_IMPORT_OPERATION,
  THREAD_TELEPORT_LOCAL_OPERATION,
  promptInputSchema,
  type PromptInput,
  type Thread,
} from "@cloudroom/domain";
import { z } from "zod";

export type ThreadMessage = { role: "user" | "agent"; text: string };

/** A thread's user messages and agent replies, without tool calls, tool output, or agent-only context. */
export function threadMessages(
  db: DbQueryConnection,
  threadId: string,
  range: { after?: number; before?: number } = {},
): ThreadMessage[] {
  const rows = db
    .select({ type: events.type, data: events.data })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        isNull(events.parentToolCallId),
        range.after === undefined
          ? undefined
          : gt(events.sequence, range.after),
        range.before === undefined
          ? undefined
          : lt(events.sequence, range.before),
        or(
          eq(events.type, "client/turn/requested"),
          and(
            eq(events.type, "item/completed"),
            or(eq(events.itemKind, "agentMessage"), isNull(events.itemKind)),
          ),
        ),
      ),
    )
    .orderBy(asc(events.sequence))
    .all();
  return messagesFromRows(rows);
}

export function messagesFromRows(rows: readonly { type: string; data: string }[]): ThreadMessage[] {
  return rows.flatMap((row): ThreadMessage[] => {
    const data = JSON.parse(row.data) as {
      input?: unknown;
      item?: { type?: unknown; text?: unknown };
    };
    if (row.type === "client/turn/requested") {
      const parts = Array.isArray(data.input)
        ? (data.input as {
            type?: unknown;
            text?: unknown;
            visibility?: unknown;
          }[])
        : [];
      const text = parts
        .filter(
          (part) =>
            part.type === "text" &&
            part.visibility !== "agent-only" &&
            typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("\n")
        .trim();
      return text ? [{ role: "user", text }] : [];
    }
    const text =
      data.item?.type === "agentMessage" && typeof data.item.text === "string"
        ? data.item.text.trim()
        : "";
    return text ? [{ role: "agent", text }] : [];
  });
}

export const transcriptMarkdown = (
  messages: readonly ThreadMessage[],
): string =>
  messages
    .map(
      (message) =>
        `## ${message.role === "user" ? "User" : "Agent"}\n\n${message.text}`,
    )
    .join("\n\n");

const switchMetadataSchema = z.object({ seed: z.array(promptInputSchema), carried: z.literal(true).optional() });

/**
 * After a harness switch (ADR 0211) or a text-only chat import, the first turn carries the earlier conversation as
 * agent-only input, saved on that event. It stays pending until a turn starts after it. Forked imports carry no seed.
 */
export function pendingHarnessSwitchSeed(
  db: DbQueryConnection,
  threadId: string,
): { input: PromptInput[]; requestSequence: number; carried?: true } | null {
  const seed = latestOperationSeed(db, threadId, [
    THREAD_HARNESS_SWITCH_OPERATION,
    THREAD_IMPORT_OPERATION,
  ]);
  return seed &&
    !findStoredEventRow(db, {
      threadId,
      type: "turn/started",
      afterSequence: seed.requestSequence,
    })
    ? seed
    : null;
}

/** The agent-only seed saved on the newest of these operations' events. */
export function latestOperationSeed(
  db: DbQueryConnection,
  threadId: string,
  operations: readonly string[],
): { input: PromptInput[]; requestSequence: number; carried?: true } | null {
  const row = db
    .select({ sequence: events.sequence, data: events.data })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, "system/operation"),
        inArray(sql`json_extract(${events.data}, '$.operation')`, [
          ...operations,
        ]),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  if (!row) return null;
  const parsed = switchMetadataSchema.safeParse(
    (JSON.parse(row.data) as { metadata?: unknown }).metadata,
  );
  return parsed.success && parsed.data.seed.length > 0
    ? { input: parsed.data.seed, requestSequence: row.sequence, ...(parsed.data.carried ? { carried: true as const } : {}) }
    : null;
}

/** Codex's answer to resuming a session it never saved, or whose file is gone (#335). */
export const MISSING_SESSION_ERROR = /\bno rollout found for thread id\b/i;

/**
 * Whether a native session may hold history this transcript lacks (tool output, reasoning): it ran a turn, which is
 * when Codex saves it, or the thread came from a fork, a native import, a native edit fork or a Teleport.
 */
export function sessionMayHoldHistory(
  db: DbQueryConnection,
  thread: Pick<Thread, "id" | "originKind">,
  providerThreadId: string,
): boolean {
  if (thread.originKind === "fork") return true;
  const row = db
    .select({ sequence: events.sequence })
    .from(events)
    .where(
      and(
        eq(events.threadId, thread.id),
        // Both types up front, so SQLite seeks events_thread_type_sequence_idx instead of reading the whole thread.
        inArray(events.type, ["turn/started", "system/operation"]),
        or(
          and(
            eq(events.type, "turn/started"),
            eq(events.providerThreadId, providerThreadId),
          ),
          and(
            eq(events.type, "system/operation"),
            or(
              sql`json_extract(${events.data}, '$.operation') = ${THREAD_TELEPORT_LOCAL_OPERATION}`,
              sql`json_extract(${events.data}, '$.metadata.sourceProviderThreadId') IS NOT NULL`,
              sql`json_extract(${events.data}, '$.metadata.replacementProviderThreadId') IS NOT NULL`,
            ),
          ),
        ),
      ),
    )
    .limit(1)
    .get();
  return row !== undefined;
}
