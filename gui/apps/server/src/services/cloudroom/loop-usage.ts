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

/** A Cloud loop run as the website saved it: `input` is new input only, whatever the harness. */
export type CloudRun = { thread: string; at: number; harness: string; input: number; output: number; cacheRead: number; cacheWrite: number };
export const weightedRun = (run: Pick<CloudRun, "input" | "output" | "cacheRead" | "cacheWrite">): number =>
  run.input + 0.1 * run.cacheRead + 1.25 * run.cacheWrite + 5 * run.output;

let cloudRuns: { account: string; at: number; runs: Promise<CloudRun[]> } | null = null;
/** The signed-in account's Cloud loop runs of the last 8 days with what each used, read at most every 10 minutes and
 *  only when someone looks at an estimate. None when signed out, from an older website, or after a failed read, which
 *  the next look tries again. */
export function recentCloudRuns(account: string | null, ask: () => Promise<unknown>, now = Date.now()): Promise<CloudRun[]> {
  if (!account) return Promise.resolve([]);
  if (cloudRuns?.account === account && now - cloudRuns.at <= 10 * 60_000) return cloudRuns.runs;
  const entry: NonNullable<typeof cloudRuns> = { account, at: now, runs: Promise.resolve([]) };
  entry.runs = ask().then(
    (answer) => ((answer as { tokens?: CloudRun[] } | null)?.tokens ?? []).filter((run) => typeof run?.thread === "string" && Number.isFinite(run.at) && Number.isFinite(weightedRun(run))),
    () => { if (cloudRuns === entry) cloudRuns = null; return []; },
  );
  cloudRuns = entry;
  return entry.runs;
}

/** Weighted tokens each listed thread used since `threadsSince`, and all of the provider's threads since `totalSince`.
 *  A thread's totals only grow, so its use since a time is its highest total minus its highest total before then.
 *  A Cloud loop run this computer never opened has no events here: `cloud` says what it used, so it still counts. */
export function tokenUsageSince(db: DbQueryConnection, input: { providerId: string; threadIds: string[]; threadsSince: number; totalSince: number }, cloud: readonly CloudRun[] = []) {
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
  // A Cloud run counts when it started after its thread's last reading here: earlier runs, this computer already
  // counted. A same-thread loop runs many times in one thread, so a thread keeps all of its runs.
  const runs = new Map<string, CloudRun[]>();
  for (const run of cloud) if (run.harness === input.providerId) runs.set(run.thread, [...(runs.get(run.thread) ?? []), run]);
  const unseen = (id: string, rows: { at: number }[] = [], since: number) => {
    const last = Math.max(-Infinity, ...rows.map((row) => row.at));
    return (runs.get(id) ?? []).reduce((used, run) => used + (run.at >= since && run.at > last ? weightedRun(run) : 0), 0);
  };
  for (const id of runs.keys()) sum += unseen(id, provider.get(id), input.totalSince);
  return { total: sum, threads: Object.fromEntries(input.threadIds.map((id) => [id, usedSince(listed.get(id), input.threadsSince) + unseen(id, listed.get(id), input.threadsSince)])) };
}
