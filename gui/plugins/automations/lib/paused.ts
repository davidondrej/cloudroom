// A loop its own failures paused (ADR 20261101-191413), read from the error it saved when it paused. The sidebar
// label and the Overview's Paused group share this, so their counts match. Pauses older than a week stay quiet.
export type FailurePause = { failures: number; reason: string };

export const QUIET_AFTER_MS = 7 * 86_400_000;
// Local: the sweep adds "(loop paused after N consecutive failures)". Cloud: the website starts with "Paused after N failed runs.".
const LOCAL = / \(loop paused after (\d+) consecutive failures\)$/u;
const CLOUD =
  /^Paused after (\d+) failed runs\.\s*(?:Last error: |The last run failed: )?/u;
// A Local loop whose agent couldn't sign in waits for it (#609): never counted, and shown until its hold ends.
const SIGN_IN = / \(loop waits for \S+ sign-in\)$/u;
export const signInMark = (providerId: string) =>
  ` (loop waits for ${providerId} sign-in)`;
export const waitsForSignIn = (error: string | null | undefined) =>
  !!error && SIGN_IN.test(error);

export function failurePause(
  loop: { enabled: boolean; lastError: string | null | undefined; at: number },
  now: number,
): FailurePause | null {
  const error = loop.lastError;
  if (loop.enabled || !error) return null;
  const signIn = SIGN_IN.exec(error);
  if (signIn) return { failures: 0, reason: error.slice(0, signIn.index) };
  if (!(now - loop.at < QUIET_AFTER_MS)) return null;
  const local = LOCAL.exec(error);
  if (local)
    return { failures: Number(local[1]), reason: error.slice(0, local.index) };
  const cloud = CLOUD.exec(error);
  return cloud
    ? { failures: Number(cloud[1]), reason: error.slice(cloud[0].length) }
    : null;
}

/** Prompt sent to a new thread started from a paused loop's Fix button (David, 2026-11-27). */
export function buildFixLoopPrompt(loop: {
  name: string;
  id: string;
  cloud: boolean;
  reason: string;
}): string {
  const where = loop.cloud ? "Cloud" : "Local";
  const name = loop.name.replace(/[\s"]+/gu, " ").trim();
  const reason = loop.reason.replace(/\s+/gu, " ").trim();
  return [
    `Fix my paused ${where} loop "${name}" (${loop.id}).`,
    `Error: ${reason}`,
    "",
    "Inspect the loop and its latest failed run with `room-cli loop`.",
    "If the fix is obvious, apply it.",
    "Verify it works.",
    "Resume the loop.",
    "If it needs a secret or a decision, stop and tell me.",
  ].join("\n");
}
