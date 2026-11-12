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
  type: string;
  at: number;
  provider: string;
  name: string | null;
  model: string | null;
  output: number | null;
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

const TOKEN_KINDS = ["written", "read", "cached"] as const;
type TokenUse = Record<(typeof TOKEN_KINDS)[number], number>;
const TOKEN_MODELS_SHOWN = 4;
const noTokens = (): TokenUse => ({ written: 0, read: 0, cached: 0 });
const allTokens = (use: TokenUse) => use.written + use.read + use.cached;

/**
 * Tokens per day, from each thread's running totals. Old token events are pruned (event-pruning.ts), so per-turn
 * numbers are gone, but a thread's total only grows: use between two saved events is the difference, dated by the
 * later one. A drop means the provider restarted its count. Rough: a restart inside a pruned gap loses tokens.
 * Each difference counts for the model of the prompt before it, so a thread that switched models is split right.
 */
function tokens(db: DbQueryConnection, range: Range) {
  // One range early, so this range can be compared with the one before.
  const from = range.start - range.days * DAY_MS, span = range.days * 2;
  const rows = db.all<TokenRow>(sql`
    SELECT e.thread_id AS thread, e.type AS type, e.created_at AS at, t.provider_id AS provider,
      coalesce(t.title, t.title_fallback) AS name,
      json_extract(e.data, '$.execution.model') AS model,
      json_extract(e.data, '$.tokenUsage.total.outputTokens') AS output,
      json_extract(e.data, '$.tokenUsage.total.inputTokens') AS input,
      coalesce(json_extract(e.data, '$.tokenUsage.total.cacheReadInputTokens'),
        json_extract(e.data, '$.tokenUsage.total.cachedInputTokens')) AS cacheRead,
      json_extract(e.data, '$.tokenUsage.total.cacheWriteInputTokens') AS cacheWrite
    FROM threads AS t
      CROSS JOIN events AS e ON e.thread_id = t.id AND e.type IN ('thread/tokenUsage/updated', 'client/turn/requested')
    WHERE t.updated_at >= ${from}
    ORDER BY e.thread_id, e.sequence
  `);
  const lists = () => ({ written: zeros(range.days), read: zeros(range.days), cached: zeros(range.days) });
  const daily = { written: zeros(span), read: zeros(span), cached: zeros(span) };
  const models = new Map<string, ReturnType<typeof lists>>();
  const threads = zeros(range.days).map(() => new Map<string, TokenUse & { name: string }>());
  let thread = "", last = noTokens(), model = modelName(null);
  for (const row of rows) {
    if (row.thread !== thread) { thread = row.thread; last = noTokens(); model = modelName(null); }
    if (row.type === "client/turn/requested") {
      if (row.model) model = modelName(row.model);
      continue;
    }
    const cacheRead = row.cacheRead ?? 0, input = row.input ?? 0;
    // Codex counts cache reads inside its input; Claude Code counts them apart, and cache writes too.
    const total = { written: row.output ?? 0, read: row.provider === "codex" ? input - cacheRead : input + (row.cacheWrite ?? 0), cached: cacheRead };
    const base = total.written >= last.written ? last : noTokens();
    last = total;
    // Forks don't copy token events (thread-fork-history.ts), so each thread counts only its own.
    const at = Math.floor((row.at - from) / DAY_MS), day = at - range.days;
    if (at < 0 || at >= span) continue;
    const use = { written: total.written - base.written, read: Math.max(0, total.read - base.read), cached: Math.max(0, total.cached - base.cached) };
    for (const kind of TOKEN_KINDS) daily[kind][at]! += use[kind];
    if (day < 0 || allTokens(use) === 0) continue;
    const byModel = models.get(model) ?? lists(), byThread = threads[day]!.get(thread) ?? { name: row.name ?? "Untitled", ...noTokens() };
    for (const kind of TOKEN_KINDS) { byModel[kind][day]! += use[kind]; byThread[kind] += use[kind]; }
    models.set(model, byModel);
    threads[day]!.set(thread, byThread);
  }
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const list = [...models].map(([name, use]) => ({ name, ...use, total: sum(use.written) + sum(use.read) + sum(use.cached) }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  // The long tail of rarely used models shares one last row.
  const rest = list.splice(TOKEN_MODELS_SHOWN);
  if (rest.length === 1) list.push(rest[0]!);
  else if (rest.length > 1) {
    const other = { name: "Other", ...lists(), total: 0 };
    for (const one of rest) for (const kind of TOKEN_KINDS) one[kind].forEach((value, day) => { other[kind][day]! += value; });
    list.push(other);
  }
  // Each day's three heaviest threads of every kind, so the app can rank them by what is on screen.
  const top = threads.map((day) => {
    const all = [...day.values()], keep = new Set<TokenUse & { name: string }>();
    for (const size of [allTokens, ...TOKEN_KINDS.map((kind) => (use: TokenUse) => use[kind])]) {
      for (const one of [...all].sort((a, b) => size(b) - size(a)).slice(0, 3)) if (size(one) > 0) keep.add(one);
    }
    return [...keep];
  });
  return { ...daily, models: list.map(({ total: _total, ...one }) => one), top };
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
