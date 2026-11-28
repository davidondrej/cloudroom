import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { failurePause, QUIET_AFTER_MS } from "../lib/paused.js";
import { REVIEW_RETENTION_MS, type Db } from "./data.js";

// Loops their own failures paused, for the sidebar's paused label (ADR 20261101-191413). Pauses older than a week stay quiet.
export const pausedLoopSchema = z
  .object({
    /** Changes with each new pause, so each pause has its own key. */
    key: z.string(),
    kind: z.enum(["local", "cloud"]),
    id: z.string(),
    projectId: z.string().nullable(),
    name: z.string(),
    reason: z.string(),
    failures: z.number(),
    at: z.number(),
  })
  .strict();
export type PausedLoop = z.infer<typeof pausedLoopSchema>;

// The website is read at most every 15 minutes: a loop pauses after 3 failed runs, so a later label loses little.
const CLOUD_EVERY_MS = 15 * 60_000;

/** The sweep pauses a local loop by turning it off and adding "(loop paused after N consecutive failures)". One waiting
 *  for sign-in says "(loop waits for … sign-in)" and shows until its hold ends. */
export function pausedLocal(db: Db, now: number): PausedLoop[] {
  const rows = db
    .prepare(
      `SELECT id, project_id AS projectId, name, last_error AS lastError, updated_at AS at
       FROM automations
       WHERE enabled = 0 AND (last_error LIKE '%(loop paused after % consecutive failures)' AND updated_at >= ?
         OR last_error LIKE '% (loop waits for % sign-in)')`,
    )
    .all(now - QUIET_AFTER_MS) as {
    id: string;
    projectId: string;
    name: string;
    lastError: string;
    at: number;
  }[];
  return rows.flatMap((row) => {
    const pause = failurePause({ enabled: false, ...row }, now);
    return pause
      ? [
          {
            key: `local:${row.id}:${row.at}`,
            kind: "local" as const,
            id: row.id,
            projectId: row.projectId,
            name: row.name,
            ...pause,
            at: row.at,
          },
        ]
      : [];
  });
}

type LoopThread = { threadId: string; name: string; woken: number };
/** `newest`: when the account's newest Cloud loop was created (0: it has none), or null while that is not known.
 *  `woken`: the threads same-thread Cloud loops wake (#1136). */
type CloudRead = { loops: PausedLoop[]; newest: number | null; woken: LoopThread[] };
let cloud: ({ at: number } & CloudRead) | null = null;
// The website read under way: a call meanwhile (say, the sidebar's threads arrived) waits for it, not the last answer.
let reading: Promise<CloudRead> | null = null;
// Bumped by forgetCloud, so a read that started before a change never caches the old answer.
let generation = 0;

/** One read of the account's Cloud loops serves the paused label, the purpose cards' loop names, and the Scan card. A failed read keeps the last answer. */
async function readCloud(
  cloudroom: Pick<BbPluginApi["sdk"]["cloudroom"], "automations">,
  now: number,
): Promise<CloudRead> {
  if (reading) return reading;
  if (cloud && now - cloud.at < CLOUD_EVERY_MS) return cloud;
  const last: CloudRead = { loops: cloud?.loops ?? [], newest: cloud?.newest ?? null, woken: cloud?.woken ?? [] };
  const read = generation;
  cloud = { at: now, ...last };
  const current = fetchCloud(cloudroom, now)
    .then((fresh) => {
      if (fresh && read === generation) cloud = { at: now, ...fresh };
      return fresh ?? last;
    })
    .finally(() => {
      if (reading === current) reading = null;
    });
  reading = current;
  return current;
}

async function fetchCloud(
  cloudroom: Pick<BbPluginApi["sdk"]["cloudroom"], "automations">,
  now: number,
): Promise<CloudRead | null> {
  const result = await cloudroom
    .automations({ action: "list" })
    .catch(() => null);
  if (!result) return null;
  const all = result.automations ?? [];
  const newest = Math.max(0, ...all.map((loop) => Date.parse(loop.created_at) || 0));
  const loops = all.flatMap((loop) => {
    const at = Date.parse(loop.last_run_at ?? loop.created_at);
    const pause = failurePause(
      { enabled: loop.enabled, lastError: loop.last_error, at },
      now,
    );
    return pause
      ? [
          {
            key: `cloud:${loop.id}:${at}`,
            kind: "cloud" as const,
            id: loop.id,
            projectId: null,
            name: loop.name,
            ...pause,
            at,
          },
        ]
      : [];
  });
  // A fresh-thread loop's `thread_id` is the thread or project it was made from, not one it wakes. A one-time loop
  // that ran stays listed, turned off: it wakes nothing. A child's loop wakes the child its session belongs to; a
  // session not synced here yet marks nothing, not the sandbox's root thread.
  const woken = all.flatMap((loop) =>
    loop.new_thread ||
    loop.thread_id.startsWith("proj_") ||
    (!loop.enabled && loop.run_at) ||
    (loop.session_id && !loop.session_thread_id)
      ? []
      : [
          {
            threadId: loop.session_thread_id ?? loop.thread_id,
            name: loop.name,
            woken: 1,
          },
        ],
  );
  return { loops, newest, woken };
}

/** The purpose cards' loop line (#1136): text for each open thread (`open`, the threads the sidebar shows) a loop
 *  started in the last 30 days or wakes (same-thread loops). Looks up only those threads, one row each at most, so the
 *  read never grows with run history. Cloud runs are in the review list, same-thread Cloud loops in `cloudWoken`. */
export function loopThreads(
  db: Db | undefined,
  cloudWoken: LoopThread[],
  open: string[],
  now: number,
): Record<string, string> {
  const local =
    db && open.length
      ? (db
          .prepare(
            `WITH open(id) AS (SELECT value FROM json_each(@open))
             SELECT target_thread_id AS threadId, name, 1 AS woken FROM automations
             WHERE target_thread_id IN open AND NOT (trigger_type = 'once' AND enabled = 0)
             UNION ALL
             SELECT m.thread_id, a.name, 0 FROM automation_thread_marks m JOIN automations a ON a.id = m.automation_id
             WHERE m.thread_id IN open AND m.created_at >= @since
             UNION ALL
             SELECT thread_id, loop_name, 0 FROM automation_review_threads
             WHERE thread_id IN open AND created_at >= @since`,
          )
          .all({
            open: JSON.stringify(open),
            since: now - REVIEW_RETENTION_MS,
          }) as LoopThread[])
      : [];
  const shown = new Set(open);
  const names = new Map<string, [started: Set<string>, woken: Set<string>]>();
  for (const row of [...local, ...cloudWoken]) {
    if (!shown.has(row.threadId)) continue;
    const entry = names.get(row.threadId) ?? [new Set(), new Set()];
    entry[row.woken ? 1 : 0].add(row.name);
    names.set(row.threadId, entry);
  }
  const line = (verb: string, loops: Set<string>) =>
    loops.size
      ? [
          `${verb} by loop${loops.size > 1 ? "s" : ""}: ${[...loops].join(", ")}`,
        ]
      : [];
  return Object.fromEntries(
    [...names].map(([threadId, [started, woken]]) => [
      threadId,
      [...line("Started", started), ...line("Woken", woken)].join(". "),
    ]),
  );
}

type Cloudroom = Parameters<typeof readCloud>[0];
/** Cloud loops the website paused ("Paused after 3 failed runs. ..."), and the threads same-thread ones wake. */
export async function pausedCloud(cloudroom: Cloudroom, now: number): Promise<Pick<CloudRead, "loops" | "woken">> {
  const { loops, woken } = await readCloud(cloudroom, now);
  return { loops, woken };
}

/** When the newest loop was created, Local on this computer or Cloud on the account. 0: there are none.
 *  Null: the Cloud loops could not be read, so it is not known. */
export async function newestLoopAt(db: Db, cloudroom: Cloudroom, now: number): Promise<number | null> {
  const local = (db.prepare(`SELECT MAX(created_at) AS at FROM automations`).get() as { at: number | null }).at ?? 0;
  const { newest } = await readCloud(cloudroom, now);
  return newest === null ? null : Math.max(local, newest);
}

/** A Cloud loop changed here (say, resumed): the next read asks the website again. */
export function forgetCloud(): void {
  cloud = null;
  reading = null;
  generation += 1;
}
