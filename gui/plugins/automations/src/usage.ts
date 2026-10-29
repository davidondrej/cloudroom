import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CronExpressionParser } from "cron-parser";
import { getAutomation, type Db } from "./data.js";

// Usage estimates (docs/scopes/loops.md): roughly what share of the weekly Claude or Codex limit a loop uses on each
// schedule. The loop's runs in the last 7 days used a share of the provider's tokens since the limit reset; that share
// of the account's weekly %, per scheduled run, times the runs a schedule makes in a week. Rough on purpose.

const WEEK_MS = 7 * 24 * 60 * 60_000;
const LIMIT_NAMES: Record<string, string> = { "claude-code": "Claude", codex: "Codex" };

type Sdk = Pick<BbPluginApi["sdk"], "cloudroom" | "system" | "threads">;
type Week = { usedPercent: number; start: number };
export type LoopUsage = { limit: string; percents: Record<string, number> } | null;

/** How many times a cron fires from `from` to `to`; 0 for a cron that can't be read. */
function runsBetween(cron: string, timezone: string, from: number, to: number): number {
  try {
    const expression = CronExpressionParser.parse(cron, { currentDate: new Date(from), endDate: new Date(to), tz: timezone });
    let count = 0;
    while (count < 50_000 && expression.hasNext()) {
      expression.next();
      count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

// The weekly % moves slowly, and reading it can ask the provider, so it is read at most every 10 minutes.
const weeks = new Map<string, { at: number; week: Week | null }>();
async function weeklyLimit(sdk: Sdk, providerId: string): Promise<Week | null> {
  const cached = weeks.get(providerId);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.week;
  const usage = (await sdk.system.usageLimits({ providerId }).catch(() => null))?.[providerId];
  const windows = usage?.status === "ok" ? usage.windows : [];
  const window = windows.find((w) => w.label === "Weekly limit") ?? windows.find((w) => /week/i.test(w.label));
  const resets = window?.resetsAt ? Date.parse(window.resetsAt) : NaN;
  const week = window ? { usedPercent: window.usedPercent, start: (Number.isFinite(resets) ? resets : Date.now() + WEEK_MS) - WEEK_MS } : null;
  weeks.set(providerId, { at: Date.now(), week });
  return week;
}

async function estimate(
  sdk: Sdk,
  loop: { providerId: string | null; createdAt: number; cron: string | null; timezone: string; runThreadIds: string[] },
  crons: string[],
): Promise<LoopUsage> {
  const limit = loop.providerId ? LIMIT_NAMES[loop.providerId] : undefined;
  if (!limit || !loop.providerId || !loop.cron || !loop.runThreadIds.length) return null;
  const now = Date.now();
  const since = Math.max(now - WEEK_MS, loop.createdAt);
  const ticks = runsBetween(loop.cron, loop.timezone, since, now);
  const week = await weeklyLimit(sdk, loop.providerId);
  // Right after a reset there is too little use to tell a loop's share apart.
  if (!ticks || !week || week.usedPercent < 1) return null;
  const usage = await sdk.cloudroom.tokenUsage({
    providerId: loop.providerId,
    threadIds: [...new Set(loop.runThreadIds)],
    threadsSince: since,
    totalSince: Math.max(week.start, now - WEEK_MS),
  });
  // Runs whose threads never reached this Mac (Cloud runs nobody opened) count as the average known run.
  const known = loop.runThreadIds.filter((id) => (usage.threads[id] ?? 0) > 0);
  if (!known.length || usage.total <= 0) return null;
  const tokens = [...new Set(known)].reduce((sum, id) => sum + (usage.threads[id] ?? 0), 0) * (loop.runThreadIds.length / known.length);
  const perRun = ((tokens / ticks) * week.usedPercent) / usage.total;
  return { limit, percents: Object.fromEntries(crons.map((cron) => [cron, perRun * runsBetween(cron, loop.timezone, now, now + WEEK_MS)])) };
}

export async function localLoopUsage(sdk: Sdk, db: Db, automationId: string, crons: string[]): Promise<LoopUsage> {
  const automation = getAutomation(db, automationId);
  if (!automation || automation.triggerType !== "schedule") return null;
  const trigger = JSON.parse(automation.triggerConfig) as { cron?: string; timezone?: string };
  const execution = JSON.parse(automation.execution) as { mode?: string; providerId?: string };
  if (execution.mode !== "agent") return null;
  const rows = db
    .prepare("SELECT thread_id AS threadId FROM automation_runs WHERE automation_id = ? AND thread_id IS NOT NULL AND started_at >= ?")
    .all(automationId, Date.now() - WEEK_MS) as { threadId: string }[];
  return estimate(sdk, {
    providerId: execution.providerId ?? null,
    createdAt: automation.createdAt,
    cron: trigger.cron ?? null,
    timezone: trigger.timezone ?? "UTC",
    runThreadIds: rows.map((row) => row.threadId),
  }, crons);
}

export async function cloudLoopUsage(sdk: Sdk, id: string, crons: string[]): Promise<LoopUsage> {
  const { automations = [] } = await sdk.cloudroom.automations({ action: "list" });
  const loop = automations.find((automation) => automation.id === id) as
    | { thread_id: string; cron: string | null; timezone: string; created_at?: string; new_thread?: boolean; agent?: { providerId?: string | null } | null }
    | undefined;
  if (!loop?.cron) return null;
  // A same-thread loop's runs all land in its own thread; a fresh-thread loop's are listed by the website.
  const runThreadIds = loop.new_thread
    ? ((await sdk.cloudroom.automations({ action: "runs", id }).catch(() => null))?.runs ?? [])
    : [loop.thread_id];
  const providerId = loop.agent?.providerId ?? (await sdk.threads.get({ threadId: loop.thread_id }).catch(() => null))?.providerId ?? null;
  return estimate(sdk, {
    providerId,
    createdAt: loop.created_at ? Date.parse(loop.created_at) : 0,
    cron: loop.cron,
    timezone: loop.timezone,
    runThreadIds,
  }, crons);
}
