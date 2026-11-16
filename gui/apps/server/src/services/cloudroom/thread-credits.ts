import { events, getThread, type DbQueryConnection } from "@cloudroom/db";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { CloudroomError } from "./client.js";
import { cloudroom, isCloudThread } from "./commands.js";

// A Cloud thread's Cloud Credits, split by the commands that used them, for the purpose card (David, 2026-11-16,
// docs/scopes/thread-purpose.md). The website gives the billed credits and the sandbox's CPU per minute. Each minute's
// CPU goes to the commands that ran in it, by how long each ran; a minute with no command is "No command running".

export const threadCreditMinutesSchema = z.object({
  since: z.string(), credits: z.number().nullable(), minutes: z.array(z.tuple([z.number(), z.number()])),
});
export type ThreadCreditRow = { name: string; credits: number; ms: number | null; rest?: true };
/** `pending`: credits were billed, but no CPU minutes have arrived yet (Core uploads them every 5 minutes). */
export type ThreadCredits = { credits: number | null; pending: boolean; awakeMinutes: number; partial: boolean; rows: ThreadCreditRow[] };
export type Span = { start: number; end: number; name: string };
export type StartedCommand = { item: string; turn: string | null; at: number; command: string };
type Commands = { started: StartedCommand[]; ended: Map<string, number>; turnEnds: Map<string, number>; currentTurn: string | null };

const MINUTE = 60_000, TOP = 4, CACHE_MS = 60_000, MAX_SPAN_MS = 6 * 3_600_000;
// A minute can't use more than its CPUs. Rare bogus rows (a kernel thread's lifetime total) would swamp the split.
const MAX_CPU_MS = 16 * MINUTE;
const IDLE = "No command running";
// Programs that run something else: their first argument says what (`pnpm install`, `tsx repro.ts`).
const RUNNERS = new Set(["pnpm", "npm", "npx", "yarn", "bun", "bunx", "tsx", "node", "deno", "python", "python3", "uv", "pip", "pip3", "cargo", "go", "git", "gh", "room-cli", "make", "docker"]);
const cache = new Map<string, { at: number; value: ThreadCredits }>();

const base = (word: string) => word.replace(/^['"]|['"]$/g, "").split("/").pop() || word;

/** A short, safe name for a shell command: the program, plus what it runs. Never other arguments, values or paths. */
export function commandLabel(raw: string): string {
  const wrapped = /^(?:\S*\/)?(?:bash|sh|zsh)\s+-\w*c\s+(['"])([\s\S]*)\1\s*$/.exec(raw.trim());
  if (wrapped) return commandLabel(wrapped[2]!);
  let text = raw.trim();
  for (let before = ""; before !== text;) {
    before = text;
    text = text.replace(/^cd\s+\S+\s*(?:&&|;)\s*/, "").replace(/^for\s+\w+\s+in[^;]*;\s*do\s+/, "")
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "").replace(/^(?:timeout\s+\S+|time|exec|sudo(?:\s+-\S+)*)\s+/, "");
  }
  let [first = "", ...rest] = text.split(/\s+/);
  first = base(first);
  if (first === "corepack" && rest[0]) [first, ...rest] = [base(rest[0]), ...rest.slice(1)];
  if (["pnpm", "npx", "yarn", "npm", "bunx"].includes(first) && ["exec", "dlx", "x"].includes(rest[0] ?? "") && rest[1]) return base(rest[1]).slice(0, 40);
  if (RUNNERS.has(first) && rest[0] && !rest[0].startsWith("-")) return `${first} ${base(rest[0])}`.slice(0, 40);
  return (first || "shell").slice(0, 40);
}

function commandOf(data: string): string | null {
  try {
    const item = (JSON.parse(data) as { item?: { type?: string; command?: unknown; arguments?: { command?: unknown } } }).item;
    const value = item?.type === "commandExecution" ? item.command : item?.arguments?.command;
    return typeof value === "string" && value.trim() ? value : null;
  } catch { return null; }
}

/** The thread's shell commands since `since`, with their ends and their turns' ends, from its saved events. */
function readCommands(db: DbQueryConnection, threadId: string, since: number): Commands {
  const kinds = ["commandExecution", "toolCall"] as const, items = (type: "item/started" | "item/completed") =>
    and(eq(events.threadId, threadId), eq(events.type, type), inArray(events.itemKind, [...kinds]), gte(events.createdAt, since));
  const started = new Map<string, StartedCommand>();
  for (const row of db.select({ item: events.itemId, turn: events.turnId, data: events.data, at: events.createdAt }).from(events).where(items("item/started")).all()) {
    const command = row.item && !started.has(row.item) ? commandOf(row.data) : null;
    if (command) started.set(row.item!, { item: row.item!, turn: row.turn, at: row.at, command });
  }
  if (!started.size) return { started: [], ended: new Map(), turnEnds: new Map(), currentTurn: null };
  const ended = new Map(db.select({ item: events.itemId, at: events.createdAt }).from(events).where(items("item/completed")).all().flatMap((row) => row.item ? [[row.item, row.at] as const] : []));
  const turnEnds = new Map(db.select({ turn: events.turnId, at: events.createdAt }).from(events)
    .where(and(eq(events.threadId, threadId), eq(events.type, "turn/completed"), gte(events.createdAt, since))).all().flatMap((row) => row.turn ? [[row.turn, row.at] as const] : []));
  const currentTurn = db.select({ turn: events.turnId }).from(events).where(and(eq(events.threadId, threadId), eq(events.type, "turn/started")))
    .orderBy(desc(events.sequence)).limit(1).get()?.turn ?? null;
  return { started: [...started.values()], ended, turnEnds, currentTurn };
}

/** When each command ran. One with no end of its own ends with its turn; in the turn still working, it runs until now.
 *  An interrupted command whose turn has no end is dropped, so it never takes later turns' credits. */
export function commandSpans({ started, ended, turnEnds, currentTurn }: Commands, working: boolean, now: number): Span[] {
  return started.flatMap((row) => {
    const turnEnd = row.turn ? turnEnds.get(row.turn) : undefined;
    const open = working && row.turn !== null && row.turn === currentTurn ? now : row.at;
    const end = Math.min(ended.get(row.item) ?? turnEnd ?? open, row.at + MAX_SPAN_MS);
    return end > row.at ? [{ start: row.at, end, name: commandLabel(row.command) }] : [];
  });
}

/** Whole numbers that add up to `total`: floor each, then give the leftovers to the largest remainders. */
function roundToTotal(values: number[], total: number): number[] {
  const floors = values.map(Math.floor);
  const order = values.map((value, i) => [value - floors[i]!, i] as const).sort((a, b) => b[0] - a[0]);
  for (let left = total - floors.reduce((sum, value) => sum + value, 0), k = 0; left > 0 && k < order.length; left--, k++) floors[order[k]![1]]!++;
  return floors;
}

/** Splits the billed credits across commands by the CPU each used. Rows: the top 4, then the rest in one row. They
 *  always add up to the total. */
export function splitCredits(credits: number | null, minutes: [number, number][], spans: Span[]): Pick<ThreadCredits, "credits" | "pending" | "rows"> {
  if (credits === null) return { credits: null, pending: false, rows: [] };
  const sorted = [...minutes].sort((a, b) => a[0] - b[0]), cpu = new Map<string, number>(), wall = new Map<string, number>();
  const add = (map: Map<string, number>, name: string, value: number) => map.set(name, (map.get(name) ?? 0) + value);
  const overlaps: [string, number][][] = sorted.map(() => []);
  for (const span of spans) {
    add(wall, span.name, span.end - span.start);
    let low = 0, high = sorted.length;
    while (low < high) { const mid = (low + high) >> 1; if (sorted[mid]![0] <= span.start) low = mid + 1; else high = mid; }
    for (let i = low; i < sorted.length && sorted[i]![0] - MINUTE < span.end; i++) {
      const at = sorted[i]![0], overlap = Math.min(span.end, at) - Math.max(span.start, at - MINUTE);
      if (overlap > 0) overlaps[i]!.push([span.name, overlap]);
    }
  }
  let all = 0;
  sorted.forEach(([, ms], i) => {
    const used = Math.min(ms, MAX_CPU_MS), parts = overlaps[i]!, total = parts.reduce((sum, [, overlap]) => sum + overlap, 0);
    all += used;
    if (!total) add(cpu, IDLE, used);
    else for (const [name, overlap] of parts) add(cpu, name, used * overlap / total);
  });
  const total = Math.round(credits);
  if (total < 1 || all <= 0) return { credits: total, pending: total >= 1, rows: [] };
  const ranked = [...cpu].map(([name, used]) => ({ name, exact: used / all * total })).sort((a, b) => b.exact - a.exact);
  const top = ranked.filter((row) => row.exact >= 0.5).slice(0, TOP), rest = ranked.slice(top.length);
  const shown = [...top.map((row) => ({ name: row.name, exact: row.exact, rest: false })),
    ...(rest.length ? [{ name: rest.some((row) => row.name === IDLE) ? "Everything else" : `${rest.length} more command${rest.length === 1 ? "" : "s"}`,
      exact: total - top.reduce((sum, row) => sum + row.exact, 0), rest: true }] : [])];
  const rounded = roundToTotal(shown.map((row) => Math.max(0, row.exact)), total);
  const rows = shown.flatMap((row, i): ThreadCreditRow[] => rounded[i]! < 1 ? [] : [row.rest
    ? { name: row.name, credits: rounded[i]!, ms: null, rest: true }
    : { name: row.name, credits: rounded[i]!, ms: row.name === IDLE ? null : wall.get(row.name) ?? null }]);
  return { credits: total, pending: false, rows };
}

/** Asked when the purpose card opens; one website read per thread a minute at most. */
export async function threadCredits(deps: AppDeps, threadId: string): Promise<ThreadCredits> {
  const thread = getThread(deps.db, threadId);
  if (!thread || !isCloudThread(thread)) throw new ApiError(404, "not_found", "No Cloud thread with this ID.");
  const cached = cache.get(threadId), now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const site = await cloudroom(deps).sandboxes.threadCredits(threadId).catch((error: unknown) => {
    throw new ApiError(error instanceof CloudroomError && error.status ? 400 : 503, "cloud_thread_credits", error instanceof Error ? error.message : String(error));
  });
  const since = Date.parse(site.since);
  const spans = commandSpans(readCommands(deps.db, threadId, since - MAX_SPAN_MS), thread.status === "active", now);
  const value = { ...splitCredits(site.credits, site.minutes, spans), awakeMinutes: site.minutes.length, partial: thread.createdAt < since };
  cache.set(threadId, { at: now, value });
  return value;
}
