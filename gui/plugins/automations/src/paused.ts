import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Db } from "./data.js";

// Loops their own failures paused, for the app's paused-loop card (ADR 0338). Pauses older than a week stay quiet.
export const pausedLoopSchema = z
  .object({
    /** Changes with each new pause, so a dismissed card comes back only for a later one. */
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

const WEEK_MS = 7 * 86_400_000;
// The website is read at most every 15 minutes: a loop pauses after 3 failed runs, so a later card loses little.
const CLOUD_EVERY_MS = 15 * 60_000;

/** The sweep pauses a local loop by turning it off and adding "(loop paused after N consecutive failures)". */
export function pausedLocal(db: Db, now: number): PausedLoop[] {
  const rows = db
    .prepare(
      `SELECT id, project_id AS projectId, name, last_error AS lastError,
         consecutive_failures AS failures, updated_at AS at
       FROM automations
       WHERE enabled = 0 AND last_error LIKE '%(loop paused after % consecutive failures)' AND updated_at >= ?`,
    )
    .all(now - WEEK_MS) as {
    id: string;
    projectId: string;
    name: string;
    lastError: string;
    failures: number;
    at: number;
  }[];
  return rows.map((row) => ({
    key: `local:${row.id}:${row.at}`,
    kind: "local",
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    reason: row.lastError.replace(
      / \(loop paused after \d+ consecutive failures\)$/,
      "",
    ),
    failures: row.failures,
    at: row.at,
  }));
}

let cloud: { at: number; loops: PausedLoop[] } | null = null;

/** Cloud loops the website paused ("Paused after 3 failed runs. ..."). A failed read keeps the last answer. */
export async function pausedCloud(
  cloudroom: Pick<BbPluginApi["sdk"]["cloudroom"], "automations">,
  now: number,
): Promise<PausedLoop[]> {
  if (cloud && now - cloud.at < CLOUD_EVERY_MS) return cloud.loops;
  const last = cloud?.loops ?? [];
  cloud = { at: now, loops: last };
  const result = await cloudroom
    .automations({ action: "list" })
    .catch(() => null);
  if (!result) return last;
  cloud.loops = (result.automations ?? []).flatMap((loop) => {
    const at = Date.parse(loop.last_run_at ?? loop.created_at);
    if (loop.enabled || !loop.last_error?.startsWith("Paused after "))
      return [];
    if (!(now - at < WEEK_MS)) return [];
    return [
      {
        key: `cloud:${loop.id}:${at}`,
        kind: "cloud" as const,
        id: loop.id,
        projectId: null,
        name: loop.name,
        reason: loop.last_error.replace(
          /^Paused after \d+ failed runs\. (Last error: )?/,
          "",
        ),
        failures: loop.failures,
        at,
      },
    ];
  });
  return cloud.loops;
}

/** A Cloud loop changed here (say, resumed): the next read asks the website again. */
export function forgetCloud(): void {
  cloud = null;
}
