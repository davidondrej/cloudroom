// A loop its own failures paused (ADR 20261101-191413), read from the error it saved when it paused. The sidebar
// label and the Overview's Paused group share this, so their counts match. Pauses older than a week stay quiet.
export type FailurePause = { failures: number; reason: string };

export const QUIET_AFTER_MS = 7 * 86_400_000;
// Local: the sweep adds "(loop paused after N consecutive failures)". Cloud: the website starts with "Paused after N failed runs.".
const LOCAL = / \(loop paused after (\d+) consecutive failures\)$/u;
const CLOUD =
  /^Paused after (\d+) failed runs\.\s*(?:Last error: |The last run failed: )?/u;

export function failurePause(
  loop: { enabled: boolean; lastError: string | null | undefined; at: number },
  now: number,
): FailurePause | null {
  const error = loop.lastError;
  if (loop.enabled || !error || !(now - loop.at < QUIET_AFTER_MS)) return null;
  const local = LOCAL.exec(error);
  if (local)
    return { failures: Number(local[1]), reason: error.slice(0, local.index) };
  const cloud = CLOUD.exec(error);
  return cloud
    ? { failures: Number(cloud[1]), reason: error.slice(cloud[0].length) }
    : null;
}
