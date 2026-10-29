import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { events, threads, type DbQueryConnection } from "@cloudroom/db";

// Loop usage estimates (docs/scopes/loops.md): the Loops plugin compares the tokens its runs used with all of the
// provider's tokens since the weekly limit reset, then scales the account's weekly % by that share.

const total = (field: string) => sql<number | null>`json_extract(${events.data}, ${`$.tokenUsage.total.${field}`})`;

/** Tokens weighted like API prices, so cheap cached context counts less than new input and output. */
export function weightedTokens(tokens: { input: number | null; cacheRead: number | null; cached: number | null; cacheWrite: number | null; output: number | null }): number {
  const read = tokens.cacheRead ?? tokens.cached ?? 0;
  const input = tokens.input ?? 0;
  // Codex counts cache reads inside its input; Claude Code counts them apart.
  const fresh = input > read ? input - read : input;
  return fresh + 0.1 * read + 1.25 * (tokens.cacheWrite ?? 0) + 5 * (tokens.output ?? 0);
}

/** Weighted tokens each listed thread used since `threadsSince`, and all of the provider's threads since `totalSince`.
 *  A thread's totals only grow, so its use since a time is its highest total minus its highest total before then. */
export function tokenUsageSince(db: DbQueryConnection, input: { providerId: string; threadIds: string[]; threadsSince: number; totalSince: number }) {
  // Through the thread index: scanning every event by type takes about a second on a big history.
  const read = (threadIds: ReturnType<typeof inArray>) => db
    .select({ threadId: events.threadId, at: events.createdAt, input: total("inputTokens"), cacheRead: total("cacheReadInputTokens"), cached: total("cachedInputTokens"), cacheWrite: total("cacheWriteInputTokens"), output: total("outputTokens") })
    .from(events).where(and(eq(events.type, "thread/tokenUsage/updated"), threadIds)).all();
  const totals = (rows: ReturnType<typeof read>) => {
    const byThread = new Map<string, { at: number; tokens: number }[]>();
    for (const row of rows) byThread.set(row.threadId, [...(byThread.get(row.threadId) ?? []), { at: row.at, tokens: weightedTokens(row) }]);
    return byThread;
  };
  const usedSince = (rows: { at: number; tokens: number }[] = [], at: number) => {
    if (!rows.some((row) => row.at >= at)) return 0;
    const before = Math.max(0, ...rows.filter((row) => row.at < at).map((row) => row.tokens));
    return Math.max(0, Math.max(...rows.map((row) => row.tokens)) - before);
  };
  const provider = totals(read(inArray(events.threadId, db.select({ id: threads.id }).from(threads).where(and(eq(threads.providerId, input.providerId), gte(threads.updatedAt, input.totalSince))))));
  const listed = input.threadIds.length ? totals(read(inArray(events.threadId, input.threadIds))) : new Map<string, { at: number; tokens: number }[]>();
  let sum = 0;
  for (const rows of provider.values()) sum += usedSince(rows, input.totalSince);
  return { total: sum, threads: Object.fromEntries(input.threadIds.map((id) => [id, usedSince(listed.get(id), input.threadsSince)])) };
}
