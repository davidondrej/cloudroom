import type { DbQueryConnection } from "@cloudroom/db";
import type {
  SystemSkillUsageQuery,
  SystemSkillUsageResponse,
} from "@cloudroom/server-contract";
import { sql } from "drizzle-orm";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One detected skill run, before names are parsed and duplicates dropped. */
export interface SkillUseRow {
  /** `name`: a skill name; `path`: a file path; `command`: a shell command. */
  kind: "name" | "path" | "command";
  /** Raw JSON value; anything but a string is skipped. */
  value: unknown;
  at: number;
  /**
   * Same key + same skill counts once (one prompt, or one agent turn). Keys
   * use ids that fork copies keep, so a forked thread doesn't count again.
   */
  key: string;
}

/**
 * Finds skill runs in thread history, Local and Cloud: `/skill` mentions in
 * turn requests, `Skill` tool calls, and agents reading one `SKILL.md`
 * (`fileRead`, `commandExecution`, or Cloud Claude's `Read`/`Bash` calls).
 * Turn requests are read per thread (`events_thread_type_sequence_idx`); the
 * items filter matches `events_completed_item_truncation_idx`.
 */
export function readSkillUseRows(
  db: DbQueryConnection,
  since: number,
  until = Number.MAX_SAFE_INTEGER,
): SkillUseRow[] {
  return db.all<SkillUseRow>(sql`
    SELECT 'name' AS kind,
      json_extract(mention.value, '$.resource.name') AS value,
      e.created_at AS at,
      'p:' || e.created_at || ':' || json_extract(e.data, '$.requestId') AS key
    FROM threads AS t
      CROSS JOIN events AS e ON e.thread_id = t.id
        AND e.type = 'client/turn/requested',
      json_each(e.data, '$.input') AS item,
      json_each(item.value, '$.mentions') AS mention
    WHERE e.created_at >= ${since} AND e.created_at < ${until}
      AND json_extract(e.data, '$.retryAttempt') IS NULL
      AND json_extract(mention.value, '$.resource.kind') = 'command'
      AND json_extract(mention.value, '$.resource.source') = 'skill'
    UNION ALL
    SELECT CASE
        WHEN item_kind = 'toolCall' AND json_extract(data, '$.item.tool') = 'Skill' THEN 'name'
        WHEN item_kind = 'fileRead' OR json_extract(data, '$.item.tool') = 'Read' THEN 'path'
        ELSE 'command' END AS kind,
      CASE item_kind
        WHEN 'fileRead' THEN json_extract(data, '$.item.path')
        WHEN 'commandExecution' THEN json_extract(data, '$.item.command')
        ELSE coalesce(
          json_extract(data, '$.item.arguments.skill'),
          json_extract(data, '$.item.arguments.file_path'),
          json_extract(data, '$.item.arguments.command')) END AS value,
      created_at AS at,
      't:' || coalesce(provider_thread_id, '') || ':' || coalesce(turn_id, '') AS key
    FROM events
    WHERE type = 'item/completed'
      AND item_kind IN ('toolCall', 'fileRead', 'commandExecution')
      AND created_at >= ${since} AND created_at < ${until}
      AND CASE item_kind
        WHEN 'toolCall' THEN json_extract(data, '$.item.tool') = 'Skill'
          OR (json_extract(data, '$.item.tool') IN ('Read', 'Bash')
            AND instr(data, 'SKILL.md') > 0)
        ELSE instr(data, 'SKILL.md') > 0 END
  `);
}

const SKILL_FILE = /([\w.-]+)\/SKILL\.md\b/g;
const READ_COMMAND = /\b(cat|sed|head|tail|nl|bat|less|more|awk)\b/;
const WRITE_COMMAND =
  /(^|[^>])>[^>&]|\bsed\s+-i|\b(rm|mv|cp|tee|apply_patch)\b/;

/** `plugin:name` → `name`. The app strips installed skill names the same way. */
export function normalizeSkillName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1).trim();
}

/** Returns the skill a row ran, or null when it isn't a clear single read. */
export function skillNameFromUse(
  row: Pick<SkillUseRow, "kind" | "value">,
): string | null {
  const value = typeof row.value === "string" ? row.value.trim() : "";
  if (!value) return null;
  if (row.kind === "name") return normalizeSkillName(value) || null;
  const files = [...value.matchAll(SKILL_FILE)];
  if (files.length !== 1) return null;
  if (
    row.kind === "command" &&
    (!READ_COMMAND.test(value) || WRITE_COMMAND.test(value))
  ) {
    return null;
  }
  return files[0]![1]!;
}

export interface BuildSkillUsageArgs {
  days: number;
  now: number;
  utcOffsetMinutes: number;
}

/** First local day of the range, as UTC ms of local midnight. */
export function rangeStart(args: BuildSkillUsageArgs): number {
  const offset = args.utcOffsetMinutes * 60_000;
  const today = Math.floor((args.now + offset) / DAY_MS) * DAY_MS;
  return today - (args.days - 1) * DAY_MS - offset;
}

export function buildSkillUsage(
  rows: readonly SkillUseRow[],
  args: BuildSkillUsageArgs,
): SystemSkillUsageResponse {
  const start = rangeStart(args);
  const seen = new Set<string>();
  const daily = new Map<string, number[]>();
  for (const row of rows) {
    const name = skillNameFromUse(row);
    const day = Math.floor((row.at - start) / DAY_MS);
    if (!name || day < 0 || day >= args.days) continue;
    const dedupeKey = `${row.key}\n${name}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const counts = daily.get(name) ?? new Array<number>(args.days).fill(0);
    counts[day]! += 1;
    daily.set(name, counts);
  }
  const skills = [...daily]
    .map(([name, counts]) => ({
      name,
      total: counts.reduce((sum, count) => sum + count, 0),
      daily: counts,
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const startDate = new Date(start + args.utcOffsetMinutes * 60_000)
    .toISOString()
    .slice(0, 10);
  return { startDate, days: args.days, skills };
}

export function readSkillUsage(
  deps: { db: DbQueryConnection },
  query: SystemSkillUsageQuery,
  now = Date.now(),
): SystemSkillUsageResponse {
  const args = {
    days: Number(query.days ?? "90"),
    now,
    utcOffsetMinutes: Number(query.utcOffsetMinutes ?? "0"),
  };
  return buildSkillUsage(readSkillUseRows(deps.db, rangeStart(args)), args);
}
