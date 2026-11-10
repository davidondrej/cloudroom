/**
 * What a Mac that views another Mac saves about its requests to it, in `logs/desktop.log`. The viewed Mac's logs can't
 * show a request that never reached it. On 2026-11-10 sends from an Air hung in the relay for up to 30 minutes and
 * neither Mac had a trace of it.
 */

/** A request this slow, or with no answer for this long, gets its own line. */
export const SLOW_REQUEST_MS = 5_000;
const STUCK_REQUEST_MS = 15_000;
const STUCK_CHECK_MS = 5_000;
const SUMMARY_MS = 60_000;

/** The parts of Electron's web request events this log reads. */
export interface TrackedRequest {
  id: number;
  method: string;
  url: string;
  resourceType: string;
  statusCode?: number;
  error?: string;
}

interface Pending {
  startedAt: number;
  label: string;
  answered: boolean;
  stuckLogged: boolean;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Logs trouble on the requests this window sends to the Mac it shows: slow, failed, and stuck ones as they happen, and
 * one summary line a minute. Paths only, never query strings or bodies.
 */
export function createOtherMacRequestLog(args: {
  /** The other Mac's address while this window shows it, else null. */
  viewing: () => string | null;
  log: (line: string) => void;
  now?: () => number;
}) {
  const now = args.now ?? Date.now;
  const pending = new Map<number, Pending>();
  let durations: number[] = [];
  let failed = 0;
  let stuck = 0;
  let lastSummaryAt = now();

  const finish = (request: TrackedRequest): { entry: Pending; ms: number } | null => {
    const entry = pending.get(request.id);
    if (entry === undefined) return null;
    pending.delete(request.id);
    return { entry, ms: now() - entry.startedAt };
  };

  return {
    started(request: TrackedRequest): void {
      const origin = args.viewing();
      // A live socket stays open for hours, so it is never "slow".
      if (origin === null || request.resourceType === "webSocket" || !request.url.startsWith(`${new URL(origin).origin}/`)) return;
      pending.set(request.id, {
        startedAt: now(),
        label: `${request.method} ${new URL(request.url).pathname}`,
        answered: false,
        stuckLogged: false,
      });
    },
    /** The first byte of the answer arrived. A long stream after this is not stuck. */
    answered(request: TrackedRequest): void {
      const entry = pending.get(request.id);
      if (entry !== undefined) entry.answered = true;
    },
    completed(request: TrackedRequest): void {
      const done = finish(request);
      if (done === null) return;
      durations.push(done.ms);
      const status = request.statusCode ?? 0;
      if (status >= 500) failed += 1;
      if (status >= 500 || done.ms >= SLOW_REQUEST_MS) {
        args.log(`[other-mac] ${status >= 500 ? "failed" : "slow"} ${done.entry.label} → ${status} in ${seconds(done.ms)}`);
      }
    },
    errored(request: TrackedRequest): void {
      const done = finish(request);
      if (done === null) return;
      // The app cancels its own requests all the time (typing, switching threads). Only a long wait is news.
      const canceled = request.error === "net::ERR_ABORTED";
      if (canceled && done.ms < SLOW_REQUEST_MS) return;
      failed += 1;
      args.log(`[other-mac] ${canceled ? "gave up on" : "failed"} ${done.entry.label} after ${seconds(done.ms)} (${request.error ?? "unknown error"})`);
    },
    /** Call every few seconds: logs requests still waiting for an answer, and the minute's summary. */
    tick(): void {
      const time = now();
      for (const entry of pending.values()) {
        if (entry.answered || entry.stuckLogged || time - entry.startedAt < STUCK_REQUEST_MS) continue;
        entry.stuckLogged = true;
        stuck += 1;
        args.log(`[other-mac] stuck ${entry.label}: no answer after ${seconds(time - entry.startedAt)}`);
      }
      if (time - lastSummaryAt < SUMMARY_MS) return;
      lastSummaryAt = time;
      if (durations.length === 0 && failed === 0 && stuck === 0) return;
      const sorted = durations.sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      const waiting = [...pending.values()].filter((entry) => !entry.answered).length;
      args.log(
        `[other-mac] last minute: ${sorted.length} answered (median ${Math.round(median)} ms, slowest ${seconds(sorted.at(-1) ?? 0)}), ` +
          `${failed} failed, ${stuck} stuck, ${waiting} waiting now`,
      );
      durations = [];
      failed = 0;
      stuck = 0;
    },
    tickMs: STUCK_CHECK_MS,
  };
}
