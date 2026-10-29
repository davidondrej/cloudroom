import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import {
  events,
  findStoredEventRow,
  type DbQueryConnection,
} from "@cloudroom/db";
import {
  THREAD_HARNESS_SWITCH_OPERATION,
  THREAD_IMPORT_OPERATION,
  promptInputSchema,
  type PromptInput,
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

const switchMetadataSchema = z.object({ seed: z.array(promptInputSchema) });

/**
 * After a harness switch (ADR 0211) or a text-only chat import, the first turn carries the earlier conversation as
 * agent-only input, saved on that event. It stays pending until a turn starts after it. Forked imports carry no seed.
 */
export function pendingHarnessSwitchSeed(
  db: DbQueryConnection,
  threadId: string,
): { input: PromptInput[]; requestSequence: number } | null {
  const row = db
    .select({ sequence: events.sequence, data: events.data })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, "system/operation"),
        sql`json_extract(${events.data}, '$.operation') IN (${THREAD_HARNESS_SWITCH_OPERATION}, ${THREAD_IMPORT_OPERATION})`,
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  if (
    !row ||
    findStoredEventRow(db, {
      threadId,
      type: "turn/started",
      afterSequence: row.sequence,
    })
  )
    return null;
  const parsed = switchMetadataSchema.safeParse(
    (JSON.parse(row.data) as { metadata?: unknown }).metadata,
  );
  return parsed.success && parsed.data.seed.length > 0
    ? { input: parsed.data.seed, requestSequence: row.sequence }
    : null;
}
