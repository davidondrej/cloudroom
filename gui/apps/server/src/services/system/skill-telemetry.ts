import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DbQueryConnection } from "@cloudroom/db";
import { sql } from "drizzle-orm";
import type { ServerLogger } from "../../types.js";
import { buildSkillUsage, readSkillUseRows } from "./skill-usage.js";
import type { TelemetryEvent, TelemetryService } from "./telemetry.js";
import { countsAsAgent } from "./wrapped.js";

// Skill use per day (docs/scopes/skill-suggestions.md): one `skill_usage` event per finished UTC day, with the skills
// run and the agents started on this computer. Numbers only: no skill names. The website ranks accounts by runs per
// agent. A Cloud thread followed on two computers counts on both, in both numbers, so the rate holds.
// The first send covers the last 30 days from saved history, so the ranking starts full.

const HOUR_MS = 3_600_000, DAY_MS = 86_400_000, BACKFILL_DAYS = 30, CHUNK_DAYS = 3, FIRST_SEND_MS = 3 * 60_000;
const FILE = "cloudroom-skill-telemetry.json";

type SkillUsage = Extract<TelemetryEvent, { name: "skill_usage" }>["properties"];

/** Skill runs and agents started on each UTC day from `from` up to `to` (both UTC midnights). Empty days are left out. */
export function skillUseByDay(db: DbQueryConnection, from: number, to: number): SkillUsage[] {
  const days = Math.round((to - from) / DAY_MS);
  if (days <= 0) return [];
  const runs = new Array<number>(days).fill(0), threads = new Array<number>(days).fill(0);
  for (const skill of buildSkillUsage(readSkillUseRows(db, from, to), { days, now: to - 1, utcOffsetMinutes: 0 }).skills) {
    skill.daily.forEach((count, day) => { runs[day]! += count; });
  }
  const started = db.all<{ day: number; threads: number }>(sql`
    SELECT CAST((t.created_at - ${from}) / ${DAY_MS} AS INTEGER) AS day, count(*) AS threads FROM threads AS t
    WHERE t.created_at >= ${from} AND t.created_at < ${to} AND ${countsAsAgent} GROUP BY 1
  `);
  for (const row of started) threads[row.day] = row.threads;
  return runs.flatMap((skillRuns, day) => skillRuns + threads[day]! === 0 ? []
    : [{ day: new Date(from + day * DAY_MS).toISOString().slice(0, 10), skill_runs: skillRuns, threads: threads[day]! }]);
}

/** The first day not sent yet: 30 days back on first run; a damaged file starts from today, so no day is sent twice. */
async function readNext(file: string, today: number): Promise<number> {
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return today - BACKFILL_DAYS * DAY_MS;
  try {
    const next = (JSON.parse(text) as { next?: unknown }).next;
    if (typeof next === "number" && Number.isFinite(next)) return Math.max(next, today - BACKFILL_DAYS * DAY_MS);
  } catch { /* damaged: start from today */ }
  return today;
}

/** Sends each finished day's skill use once, checking every hour. */
export function installSkillTelemetry(deps: { db: DbQueryConnection; telemetry: TelemetryService; dataDir: string; logger: ServerLogger }): () => void {
  const file = join(deps.dataDir, FILE);
  let sending = false;
  const send = async () => {
    if (sending) return;
    sending = true;
    try {
      const today = Math.floor(Date.now() / DAY_MS) * DAY_MS, from = await readNext(file, today);
      if (from >= today) return;
      // A few days at a time, so the first send's 30 days never hold the server up.
      for (let start = from; start < today; start += CHUNK_DAYS * DAY_MS) {
        for (const properties of skillUseByDay(deps.db, start, Math.min(start + CHUNK_DAYS * DAY_MS, today))) deps.telemetry.capture({ name: "skill_usage", properties });
        await new Promise((resolve) => setImmediate(resolve));
      }
      await writeFile(file, JSON.stringify({ next: today }), { mode: 0o600 });
    } catch (error) {
      deps.logger.debug({ err: error }, "Skill telemetry failed");
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
