import type { DbQueryConnection } from "@cloudroom/db";
import type {
  SystemUsageAnalyticsQuery,
  SystemUsageAnalyticsResponse,
} from "@cloudroom/server-contract";
import { sql } from "drizzle-orm";
import type { AppDeps } from "../../types.js";
import { timeInApp } from "../cloudroom/time-in-app.js";
import { rangeStart } from "./skill-usage.js";

// Settings → Analytics (docs/scopes/settings-analytics.md): agent hours, models, tokens and prompts, worked out
// from thread history on each load. Events are read per thread (`events_thread_type_sequence_idx`), and only for
// threads touched since the range began.

const DAY_MS = 24 * 60 * 60 * 1000;
/** Loop runs look like user prompts. These prefixes mark them: plugins/automations run.ts and web/lib/automations.ts. */
const LOOP_PREFIXES = ["[room-cli automation due:", '[Cloudroom automation "'];

const MODELS_SHOWN = 8;

interface Range { start: number; days: number; offset: number }
const zeros = (length: number) => new Array<number>(length).fill(0);
const round = (values: number[]) => values.map((value) => Math.round(value * 100) / 100);
/** The day's place in the range, or -1 outside it. */
function dayOf(range: Range, at: number): number {
  const day = Math.floor((at - range.start) / DAY_MS);
  return day >= 0 && day < range.days ? day : -1;
}
const dateOf = (range: Range, day: number) =>
  new Date(range.start + range.offset + day * DAY_MS).toISOString().slice(0, 10);

/** Hours agents spent in turns per day, Local and Cloud. A turn past midnight is split between its days. */
function agentHours(db: DbQueryConnection, range: Range) {
  const rows = db.all<{ thread: string; turn: string | null; type: string; at: number; target: string }>(sql`
    SELECT e.thread_id AS thread, e.turn_id AS turn, e.type AS type, e.created_at AS at, t.execution_target AS target
    FROM threads AS t
      CROSS JOIN events AS e ON e.thread_id = t.id AND e.type IN ('turn/started', 'turn/completed')
    WHERE t.updated_at >= ${range.start} AND e.parent_tool_call_id IS NULL
  `);
  const started = new Map<string, number>();
  for (const row of rows) if (row.type === "turn/started") started.set(`${row.thread}\n${row.turn}`, row.at);
  const local = zeros(range.days), cloud = zeros(range.days), seen = new Set<string>();
  for (const row of rows) {
    const from = started.get(`${row.thread}\n${row.turn}`);
    // Turns still running are left out. Forks copy their parent's turns: same turn id, same start.
    if (row.type !== "turn/completed" || row.turn === null || from === undefined || seen.has(`${row.turn}\n${from}`)) continue;
    seen.add(`${row.turn}\n${from}`);
    const daily = row.target === "cloud" ? cloud : local;
    for (let day = Math.max(0, Math.floor((from - range.start) / DAY_MS)); day < range.days; day += 1) {
      const dayStart = range.start + day * DAY_MS;
      if (dayStart >= row.at) break;
      daily[day]! += Math.max(0, Math.min(row.at, dayStart + DAY_MS) - Math.max(from, dayStart)) / 3_600_000;
    }
  }
  return { local: round(local), cloud: round(cloud) };
}

interface PromptRow {
  at: number;
  target: string;
  child: number;
  request: string | null;
  model: string | null;
  initiator: string | null;
  source: string | null;
  text: string | null;
}

/** Every prompt in the range, once: retries are skipped, and so are the copies a fork keeps. */
function readPrompts(db: DbQueryConnection, range: Range): PromptRow[] {
  const seen = new Set<string>();
  return db.all<PromptRow>(sql`
    SELECT e.created_at AS at, t.execution_target AS target, t.parent_thread_id IS NOT NULL AS child,
      json_extract(e.data, '$.requestId') AS request,
      json_extract(e.data, '$.execution.model') AS model,
      json_extract(e.data, '$.initiator') AS initiator,
      json_extract(e.data, '$.source') AS source,
      substr(json_extract(e.data, '$.input[0].text'), 1, 32) AS text
    FROM threads AS t
      CROSS JOIN events AS e ON e.thread_id = t.id AND e.type = 'client/turn/requested'
    WHERE t.updated_at >= ${range.start} AND e.created_at >= ${range.start}
      AND json_extract(e.data, '$.retryAttempt') IS NULL
  `).filter((row) => {
    const key = `${row.at}\n${row.request}`;
    if (dayOf(range, row.at) < 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `openrouter/anthropic/claude-opus-5-5[1m]` → `Opus 5.5`, so one model is one row however it was reached. */
export function modelName(raw: string | null): string {
  const id = (raw ?? "").replace(/\[.*?\]/g, "").split("/").pop()!
    .replace(/-\d{8}$/, "").replace(/(\d)-(?=\d)/g, "$1.").replace(/^claude-/, "");
  if (!id) return "Unknown";
  return id.split("-").map((part) => (part === "gpt" ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ").replace(/^GPT /, "GPT-");
}

function models(rows: readonly PromptRow[], range: Range) {
  const daily = new Map<string, number[]>();
  let cloud = 0;
  for (const row of rows) {
    const name = modelName(row.model), counts = daily.get(name) ?? zeros(range.days);
    counts[dayOf(range, row.at)]! += 1;
    daily.set(name, counts);
    if (row.target === "cloud") cloud += 1;
  }
  const list = [...daily].map(([name, counts]) => ({ name, total: counts.reduce((sum, count) => sum + count, 0), daily: counts }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  // The long tail of rarely used models shares one last row.
  const rest = list.splice(MODELS_SHOWN);
  if (rest.length === 1) list.push(rest[0]!);
  else if (rest.length > 1) {
    list.push({ name: "Other", total: rest.reduce((sum, model) => sum + model.total, 0), daily: zeros(range.days).map((_, day) => rest.reduce((sum, model) => sum + model.daily[day]!, 0)) });
  }
  return { local: rows.length - cloud, cloud, list };
}

/**
 * Prompts you sent: not loop runs, not agent messages, not the prompt a child thread was started with.
 * Known limit: most messages agents send with `room-cli` are saved as user prompts, so they count as yours.
 */
function prompts(rows: readonly PromptRow[], range: Range) {
  const daily = zeros(range.days), hours = zeros(7 * 24);
  for (const row of rows) {
    if (row.initiator !== "user" || (row.child && row.source === "spawn")) continue;
    if (LOOP_PREFIXES.some((prefix) => row.text?.startsWith(prefix))) continue;
    const local = new Date(row.at + range.offset);
    daily[dayOf(range, row.at)]! += 1;
    hours[((local.getUTCDay() + 6) % 7) * 24 + local.getUTCHours()]! += 1;
  }
  return { daily, hours };
}

interface TokenRow {
  thread: string;
  at: number;
  provider: string;
  name: string | null;
  output: number | null;
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

/**
 * Tokens per day, from each thread's running totals. Old token events are pruned (event-pruning.ts), so per-turn
 * numbers are gone, but a thread's total only grows: use between two saved events is the difference, dated by the
 * later one. A drop means the provider restarted its count. Rough: a restart inside a pruned gap loses tokens.
 */
function tokens(db: DbQueryConnection, range: Range) {
  const rows = db.all<TokenRow>(sql`
    SELECT e.thread_id AS thread, e.created_at AS at, t.provider_id AS provider,
      coalesce(t.title, t.title_fallback) AS name,
      json_extract(e.data, '$.tokenUsage.total.outputTokens') AS output,
      json_extract(e.data, '$.tokenUsage.total.inputTokens') AS input,
      coalesce(json_extract(e.data, '$.tokenUsage.total.cacheReadInputTokens'),
        json_extract(e.data, '$.tokenUsage.total.cachedInputTokens')) AS cacheRead,
      json_extract(e.data, '$.tokenUsage.total.cacheWriteInputTokens') AS cacheWrite
    FROM threads AS t
      CROSS JOIN events AS e ON e.thread_id = t.id AND e.type = 'thread/tokenUsage/updated'
    WHERE t.updated_at >= ${range.start}
    ORDER BY e.thread_id, e.sequence
  `);
  const written = zeros(range.days), top = written.map(() => new Map<string, { name: string; written: number }>());
  const none = { written: 0, read: 0, cached: 0 };
  let read = 0, cached = 0, thread = "", last = none;
  for (const row of rows) {
    if (row.thread !== thread) { thread = row.thread; last = none; }
    const cacheRead = row.cacheRead ?? 0, input = row.input ?? 0;
    // Codex counts cache reads inside its input; Claude Code counts them apart, and cache writes too.
    const total = { written: row.output ?? 0, read: row.provider === "codex" ? input - cacheRead : input + (row.cacheWrite ?? 0), cached: cacheRead };
    const base = total.written >= last.written ? last : none;
    last = total;
    // Forks don't copy token events (thread-fork-history.ts), so each thread counts only its own.
    const day = dayOf(range, row.at);
    if (day < 0) continue;
    const wrote = total.written - base.written;
    written[day]! += wrote;
    read += Math.max(0, total.read - base.read);
    cached += Math.max(0, total.cached - base.cached);
    if (wrote > 0) top[day]!.set(thread, { name: row.name ?? "Untitled", written: (top[day]!.get(thread)?.written ?? 0) + wrote });
  }
  return { written, read, cached, top: top.map((threads) => [...threads.values()].sort((a, b) => b.written - a.written).slice(0, 3)) };
}

export async function readUsageAnalytics(
  deps: Pick<AppDeps, "config" | "db">,
  query: SystemUsageAnalyticsQuery,
  now = Date.now(),
): Promise<SystemUsageAnalyticsResponse> {
  const days = Number(query.days ?? "30"), utcOffsetMinutes = Number(query.utcOffsetMinutes ?? "0");
  const range: Range = { start: rangeStart({ days, now, utcOffsetMinutes }), days, offset: utcOffsetMinutes * 60_000 };
  const response: SystemUsageAnalyticsResponse = { startDate: dateOf(range, 0), days };
  if (query.metric === "agentHours") {
    // Time in the app is saved per server-local day, in minutes.
    const active = (await timeInApp(deps)).days;
    response.agentHours = { ...agentHours(deps.db, range), you: round(zeros(days).map((_, day) => (active[dateOf(range, day)] ?? 0) / 60)) };
  } else if (query.metric === "models") response.models = models(readPrompts(deps.db, range), range);
  else if (query.metric === "tokens") response.tokens = tokens(deps.db, range);
  else response.prompts = prompts(readPrompts(deps.db, range), range);
  return response;
}
