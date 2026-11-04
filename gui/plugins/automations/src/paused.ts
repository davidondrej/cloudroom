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

/** The sweep pauses a local loop by turning it off and adding "(loop paused after N consecutive failures)". */
export function pausedLocal(db: Db, now: number): PausedLoop[] {
  const rows = db
    .prepare(
      `SELECT id, project_id AS projectId, name, last_error AS lastError, updated_at AS at
       FROM automations
       WHERE enabled = 0 AND last_error LIKE '%(loop paused after % consecutive failures)' AND updated_at >= ?`,
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

let cloud: { at: number; loops: PausedLoop[] } | null = null;
// Bumped by forgetCloud, so a read that started before a change never caches the old answer.
let generation = 0;

/** Cloud loops the website paused ("Paused after 3 failed runs. ..."). A failed read keeps the last answer. */
export async function pausedCloud(
  cloudroom: Pick<BbPluginApi["sdk"]["cloudroom"], "automations">,
  now: number,
): Promise<PausedLoop[]> {
  if (cloud && now - cloud.at < CLOUD_EVERY_MS) return cloud.loops;
  const last = cloud?.loops ?? [];
  const read = generation;
  cloud = { at: now, loops: last };
  const result = await cloudroom
    .automations({ action: "list" })
    .catch(() => null);
  if (!result) return last;
  const loops = (result.automations ?? []).flatMap((loop) => {
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
  if (read === generation) cloud = { at: now, loops };
  return loops;
}

/** A Cloud loop changed here (say, resumed): the next read asks the website again. */
export function forgetCloud(): void {
  cloud = null;
  generation += 1;
}
