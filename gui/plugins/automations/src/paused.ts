import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { failurePause, QUIET_AFTER_MS } from "../lib/paused.js";
import type { Db } from "./data.js";

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

/** `newest`: when the account's newest Cloud loop was created (0: it has none), or null while that is not known. */
type CloudRead = { loops: PausedLoop[]; newest: number | null };
let cloud: ({ at: number } & CloudRead) | null = null;
// Bumped by forgetCloud, so a read that started before a change never caches the old answer.
let generation = 0;

/** One read of the account's Cloud loops serves the paused label and the Scan card. A failed read keeps the last answer. */
async function readCloud(
  cloudroom: Pick<BbPluginApi["sdk"]["cloudroom"], "automations">,
  now: number,
): Promise<CloudRead> {
  if (cloud && now - cloud.at < CLOUD_EVERY_MS) return cloud;
  const last: CloudRead = { loops: cloud?.loops ?? [], newest: cloud?.newest ?? null };
  const read = generation;
  cloud = { at: now, ...last };
  const result = await cloudroom
    .automations({ action: "list" })
    .catch(() => null);
  if (!result) return last;
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
  if (read === generation) cloud = { at: now, loops, newest };
  return { loops, newest };
}

type Cloudroom = Parameters<typeof readCloud>[0];
/** Cloud loops the website paused ("Paused after 3 failed runs. ..."). */
export const pausedCloud = async (cloudroom: Cloudroom, now: number) => (await readCloud(cloudroom, now)).loops;

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
  generation += 1;
}
