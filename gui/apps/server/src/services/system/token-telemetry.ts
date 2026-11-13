import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DbQueryConnection } from "@cloudroom/db";
import { sql } from "drizzle-orm";
import type { ServerLogger } from "../../types.js";
import type { TelemetryEvent, TelemetryService } from "./telemetry.js";
import { modelName } from "./usage-analytics.js";

// Tokens Local threads use (docs/scopes/analytics.md#token-counts): every hour, one `token_usage` event per UTC day, agent, model
// and main thread or subagent. Numbers only: no text, titles or thread IDs. Cloud threads are counted by Core (its
// `tokens` diagnostics), so a Cloud thread followed on two computers counts once. The first send covers the last 90
// days from saved history, so the charts start full.

const HOUR_MS = 3_600_000, DAY_MS = 86_400_000, BACKFILL_DAYS = 90, FIRST_SEND_MS = 2 * 60_000;
const FILE = "cloudroom-token-telemetry.json";

type TokenUsage = Extract<TelemetryEvent, { name: "token_usage" }>["properties"];
type Totals = Pick<TokenUsage, "input" | "cached" | "cache_write" | "output">;
/** Per Local thread: the last event counted, its last total and the model of its last prompt. Kept in the data
 *  folder, so pruned history can't move a thread's base. */
interface Saved { seq: number; total: Totals | null; model: string }
export interface TokenState { through: number; threads: Record<string, Saved> }
interface Row {
  seq: number; type: string; at: number; model: string | null; retry: number | null;
  input: number | null; cached: number | null; cacheWrite: number | null; output: number | null;
  lastInput: number | null; lastCached: number | null; lastOutput: number | null;
}
const zero = (): Totals => ({ input: 0, cached: 0, cache_write: 0, output: 0 });

/**
 * Tokens Local threads used since the last send (the last 90 days the first time). A thread's totals only grow, so
 * its use is the change since its saved total, dated by the event and counted for the model of the prompt before
 * it. A drop means the agent restarted its count. A thread seen for the first time starts from its last total
 * before the window. Threads are picked by their newest event, since token events don't touch `updated_at`.
 */
export function localTokenUse(db: DbQueryConnection, state: TokenState | null, now = Date.now()): { use: TokenUsage[]; state: TokenState } {
  const from = state?.through ?? now - BACKFILL_DAYS * DAY_MS;
  const newest = (type: string) => sql`coalesce((SELECT max(e.sequence) FROM events AS e WHERE e.thread_id = t.id AND e.type = ${type}), 0)`;
  const before = (type: string) => sql`coalesce((SELECT e.sequence FROM events AS e WHERE e.thread_id = t.id AND e.type = ${type}
    AND e.created_at < ${from} ORDER BY e.sequence DESC LIMIT 1), 0)`;
  const threads = db.all<{ id: string; provider: string; child: number; seq: number; tokens: number; turns: number }>(sql`
    SELECT t.id AS id, t.provider_id AS provider, t.parent_thread_id IS NOT NULL AS child,
      max(${newest("thread/tokenUsage/updated")}, ${newest("client/turn/requested")}) AS seq,
      ${before("thread/tokenUsage/updated")} AS tokens, ${before("client/turn/requested")} AS turns
    FROM threads AS t WHERE t.execution_target = 'local' AND t.deleted_at IS NULL
  `);
  const use = new Map<string, TokenUsage>(), next: TokenState = { through: now, threads: {} };
  for (const thread of threads) {
    const saved = state?.threads[thread.id], child = thread.child === 1;
    if (saved && thread.seq <= saved.seq) { next.threads[thread.id] = saved; continue; }
    // Nothing since the window began: a later send finds its base the same way.
    if (!saved && thread.seq <= Math.max(thread.tokens, thread.turns)) continue;
    const add = (at: number, model: string, spent: Totals, turns: number) => {
      const day = new Date(at).toISOString().slice(0, 10), key = `${day}\n${thread.provider}\n${model}\n${child}`;
      const one = use.get(key) ?? { day, provider: thread.provider, model, is_child_thread: child, ...zero(), turns: 0 };
      one.input += spent.input; one.cached += spent.cached; one.cache_write += spent.cache_write; one.output += spent.output;
      one.turns += turns;
      use.set(key, one);
    };
    const after = saved ? saved.seq : Math.min(thread.tokens, thread.turns) - 1;
    const rows = db.all<Row>(sql`
      SELECT e.sequence AS seq, e.type AS type, e.created_at AS at,
        json_extract(e.data, '$.execution.model') AS model,
        json_extract(e.data, '$.retryAttempt') AS retry,
        json_extract(e.data, '$.tokenUsage.total.inputTokens') AS input,
        coalesce(json_extract(e.data, '$.tokenUsage.total.cacheReadInputTokens'),
          json_extract(e.data, '$.tokenUsage.total.cachedInputTokens')) AS cached,
        json_extract(e.data, '$.tokenUsage.total.cacheWriteInputTokens') AS cacheWrite,
        json_extract(e.data, '$.tokenUsage.total.outputTokens') AS output,
        json_extract(e.data, '$.tokenUsage.last.inputTokens') AS lastInput,
        json_extract(e.data, '$.tokenUsage.last.cachedInputTokens') AS lastCached,
        json_extract(e.data, '$.tokenUsage.last.outputTokens') AS lastOutput
      FROM events AS e
      WHERE e.thread_id = ${thread.id} AND e.type IN ('thread/tokenUsage/updated', 'client/turn/requested') AND e.sequence > ${after}
        AND e.created_at <= ${now}
      ORDER BY e.sequence
    `);
    if (rows.length === 0) { if (saved) next.threads[thread.id] = saved; continue; }
    let seq = after, last = saved?.total ?? null, model = saved?.model ?? modelName(null);
    for (const row of rows) {
      seq = row.seq;
      const counts = saved !== undefined || row.at >= from;
      if (row.type === "client/turn/requested") {
        if (row.model) model = modelName(row.model);
        if (counts && row.retry === null) add(row.at, model, zero(), 1);
        continue;
      }
      // Codex counts cache reads inside its input; Claude Code counts them apart, and cache writes too.
      const cached = row.cached ?? 0, input = row.input ?? 0;
      const total = { input: thread.provider === "codex" ? input - cached : input, cached, cache_write: row.cacheWrite ?? 0, output: row.output ?? 0 };
      // A thread's first total: a forked or imported Codex chat brings back its old totals, so only its last request is new.
      const first = thread.provider === "codex"
        ? { input: total.input - ((row.lastInput ?? 0) - (row.lastCached ?? 0)), cached: total.cached - (row.lastCached ?? 0), cache_write: 0, output: total.output - (row.lastOutput ?? 0) }
        : zero();
      const base = last === null ? first : total.output >= last.output ? last : zero();
      last = total;
      if (!counts) continue;
      const spent = { input: Math.max(0, total.input - base.input), cached: Math.max(0, total.cached - base.cached),
        cache_write: Math.max(0, total.cache_write - base.cache_write), output: total.output - base.output };
      if (spent.input + spent.cached + spent.cache_write + spent.output > 0) add(row.at, model, spent, 0);
    }
    next.threads[thread.id] = { seq, total: last, model };
  }
  return { use: [...use.values()], state: next };
}

/** The saved state: none on first run (send 90 days); a damaged file starts from now, so nothing is sent twice. */
async function readState(file: string): Promise<TokenState | null> {
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    const saved = JSON.parse(text) as Partial<TokenState>;
    if (Number.isFinite(saved.through)) return { through: saved.through!, threads: saved.threads ?? {} };
  } catch { /* damaged: start from now */ }
  return { through: Date.now(), threads: {} };
}

/** Sends Local token use every hour, from where the last send stopped (saved in the data folder). */
export function installTokenTelemetry(deps: { db: DbQueryConnection; telemetry: TelemetryService; dataDir: string; logger: ServerLogger }): () => void {
  const file = join(deps.dataDir, FILE);
  let sending = false;
  const send = async () => {
    if (sending) return;
    sending = true;
    try {
      const { use, state } = localTokenUse(deps.db, await readState(file));
      for (const [index, properties] of use.entries()) {
        deps.telemetry.capture({ name: "token_usage", properties });
        // The 90-day first send can pass the queue's 1,000 events: send as it goes.
        if (index % 100 === 99) await deps.telemetry.flush();
      }
      await writeFile(file, JSON.stringify(state), { mode: 0o600 });
    } catch (error) {
      deps.logger.debug({ err: error }, "Token telemetry failed");
    } finally {
      sending = false;
    }
  };
  const first = setTimeout(() => void send(), FIRST_SEND_MS);
  const hourly = setInterval(() => void send(), HOUR_MS);
  first.unref();
  hourly.unref();
  return () => { clearTimeout(first); clearInterval(hourly); };
}
