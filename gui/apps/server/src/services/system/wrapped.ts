import { THREAD_IMPORT_OPERATION } from "@cloudroom/domain";
import { sql } from "drizzle-orm";
import type { AppDeps } from "../../types.js";
import { cloudroom } from "../cloudroom/commands.js";
import { timeInApp } from "../cloudroom/time-in-app.js";
import { readSkillUseRows, skillNameFromUse } from "./skill-usage.js";
import { models, prompts, readPrompts, type Range } from "./usage-analytics.js";

// Monthly Wrapped (docs/scopes/wrapped.md): one month of this computer's thread history as a few numbers, worked out
// on demand like Settings → Analytics. Only the "Top N%" rank comes from the website, which gets the month and nothing else.

const DAY_MS = 24 * 60 * 60 * 1000;
const RANK_WAIT_MS = 4000;

export interface Wrapped {
  /** `2026-10`. */
  month: string;
  agents: number;
  cloud: number;
  /** Agents started by other agents. */
  subagents: number;
  /** Prompts you sent. */
  prompts: number;
  /** One entry per day of the month: minutes in the app (at least 1 on a day you sent a prompt), or your prompts when the app counted no time that month. */
  days: number[];
  /** Hours in the app, 0 when it counted no time. */
  hours: number;
  topModel: string | null;
  topHarness: string | null;
  topSkill: string | null;
  /** The hour you sent the most prompts, 0–23. */
  peakHour: number | null;
  /** "Top N%" of all accounts by agents started. Null when unknown or outside the top half. */
  top: number | null;
}

// A finished month's rank never changes, so each account asks the website once per app run.
const ranks = new Map<string, number | null>();

async function rank(deps: AppDeps, month: string): Promise<number | null> {
  const account = await cloudroom(deps).sandboxes.account().catch(() => null);
  if (!account) return null;
  const key = `${account.userId}\n${month}`;
  if (!ranks.has(key)) {
    const top = await Promise.race([
      cloudroom(deps).sandboxes.wrappedTop(month).catch(() => undefined),
      new Promise<undefined>((resolve) => setTimeout(resolve, RANK_WAIT_MS)),
    ]);
    if (top === undefined) return null;
    ranks.set(key, top);
  }
  return ranks.get(key) ?? null;
}

export async function readWrapped(deps: AppDeps, query: { month: string; utcOffsetMinutes: number }, now = Date.now()): Promise<Wrapped> {
  const [year, month] = query.month.split("-").map(Number) as [number, number];
  const offset = query.utcOffsetMinutes * 60_000;
  const range: Range = { start: Date.UTC(year, month - 1, 1) - offset, days: new Date(Date.UTC(year, month, 0)).getUTCDate(), offset };
  const end = range.start + range.days * DAY_MS;

  // Every thread started in the month is one agent. An imported chat counts once its agent has run here (ADR 20261102-073449).
  const harnesses = deps.db.all<{ provider: string; agents: number; cloud: number; subagents: number }>(sql`
    SELECT t.provider_id AS provider, count(*) AS agents,
      sum(t.execution_target = 'cloud') AS cloud, sum(t.parent_thread_id IS NOT NULL) AS subagents
    FROM threads AS t
    WHERE t.created_at >= ${range.start} AND t.created_at < ${end} AND t.visibility = 'visible'
      AND NOT EXISTS (
        SELECT 1 FROM events AS i
        WHERE i.thread_id = t.id AND i.type = 'system/operation'
          AND json_extract(i.data, '$.operation') = ${THREAD_IMPORT_OPERATION}
          AND NOT EXISTS (SELECT 1 FROM events AS r WHERE r.thread_id = t.id AND r.type = 'turn/started' AND r.sequence > i.sequence))
    GROUP BY t.provider_id ORDER BY agents DESC
  `);
  const total = (pick: (row: (typeof harnesses)[number]) => number) => harnesses.reduce((sum, row) => sum + pick(row), 0);
  const agents = total((row) => row.agents);

  const sent = readPrompts(deps.db, range), mine = prompts(sent, range);
  const byHour = new Array<number>(24).fill(0);
  mine.hours.forEach((count, hour) => { byHour[hour % 24]! += count; });
  const busiest = Math.max(...byHour);

  // Time in the app is saved per server-local day, in minutes.
  const active = (await timeInApp(deps)).days;
  const minutes = mine.daily.map((_, day) => active[new Date(range.start + offset + day * DAY_MS).toISOString().slice(0, 10)] ?? 0);
  const timed = minutes.reduce((sum, value) => sum + value, 0);

  const runs = new Map<string, number>(), seen = new Set<string>();
  for (const row of readSkillUseRows(deps.db, range.start, end)) {
    const name = skillNameFromUse(row);
    if (!name || seen.has(`${row.key}\n${name}`)) continue;
    seen.add(`${row.key}\n${name}`);
    runs.set(name, (runs.get(name) ?? 0) + 1);
  }

  return {
    month: query.month,
    agents,
    cloud: total((row) => row.cloud),
    subagents: total((row) => row.subagents),
    prompts: mine.daily.reduce((sum, count) => sum + count, 0),
    // A day with a prompt counts even when the app wasn't counting time yet.
    days: timed > 0 ? minutes.map((value, day) => value || Math.min(mine.daily[day]!, 1)) : mine.daily,
    hours: Math.round(timed / 60),
    topModel: models(sent, range).list.find((model) => model.name !== "Unknown" && model.name !== "Other")?.name ?? null,
    topHarness: harnesses[0] ? deps.providerRegistry.get(harnesses[0].provider)?.info.displayName ?? harnesses[0].provider : null,
    topSkill: [...runs].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null,
    peakHour: busiest > 0 ? byHour.indexOf(busiest) : null,
    // The website ranks finished months only.
    top: agents > 0 && end <= now ? await rank(deps, query.month) : null,
  };
}
