import { CloudroomConnectionError } from "./client.js";

/** Wait this long without a complete answer before sending one duplicate of an idempotent Core call. */
export const HEDGE_DELAY_MS = 4_000;

const isTransportError = (error: unknown): boolean =>
  error instanceof CloudroomConnectionError || (error instanceof Error && error.name === "AbortError");

/**
 * Runs a small, idempotent Core request (one that carries a `request_id` or is a read) with at most one hedged copy.
 * If attempt 1 has not returned a complete answer within `delayMs` (including a response body that stalled after
 * headers arrived) or hits a transport error first, attempt 2 runs on a fresh HTTP/1.1 connection while attempt 1
 * stays in flight. The first non-transport settlement (success or real Core HTTP error) wins and aborts the other.
 */
export function hedge<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: { delayMs?: number; signal?: AbortSignal; onHedge?: () => void } = {},
): Promise<T> {
  const { delayMs = HEDGE_DELAY_MS, signal: outer, onHedge } = options;
  if (outer?.aborted) {
    return Promise.reject(outer.reason ?? new DOMException("Cloudroom request cancelled or timed out", "AbortError"));
  }

  return new Promise<T>((resolve, reject) => {
    const controllers: AbortController[] = [];
    let settled = false;
    let hedged = false;
    let pending = 0;
    let lastError: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      outer?.removeEventListener("abort", onOuterAbort);
    };

    const finish = (outcome: { ok: true; value: T } | { ok: false; error: unknown }, winner?: AbortController) => {
      if (settled) return;
      settled = true;
      cleanup();
      for (const controller of controllers) {
        if (controller !== winner && !controller.signal.aborted) controller.abort();
      }
      if (outcome.ok) resolve(outcome.value);
      else reject(outcome.error);
    };

    const onOuterAbort = () => {
      finish({ ok: false, error: outer?.reason ?? new DOMException("Cloudroom request cancelled or timed out", "AbortError") });
    };
    outer?.addEventListener("abort", onOuterAbort, { once: true });

    const launch = (isHedge: boolean) => {
      if (settled) return;
      if (isHedge) {
        if (hedged) return;
        hedged = true;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        try { onHedge?.(); } catch { /* status notice must never break the request */ }
      }
      const controller = new AbortController();
      controllers.push(controller);
      pending += 1;
      const attemptSignal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
      Promise.resolve()
        .then(() => run(attemptSignal))
        .then(
          (value) => finish({ ok: true, value }, controller),
          (error: unknown) => {
            if (settled) return;
            pending -= 1;
            if (outer?.aborted) {
              finish({ ok: false, error: outer.reason ?? error });
              return;
            }
            // A real Core answer (4xx/5xx refusal, validation error) settles immediately — never retry or wait.
            if (!isTransportError(error)) {
              finish({ ok: false, error }, controller);
              return;
            }
            lastError = error;
            // First attempt dropped early: fire the single hedge right away instead of waiting for the timer.
            if (!hedged) {
              launch(true);
              return;
            }
            if (pending === 0) finish({ ok: false, error: lastError });
          },
        );
    };

    launch(false);
    if (!settled && !hedged) {
      timer = setTimeout(() => launch(true), delayMs);
      timer.unref?.();
    }
  });
}
