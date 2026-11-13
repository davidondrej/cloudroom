export const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
export const DEFAULT_MAX_RECONNECT_DELAY_MS = 10_000;
const DEFAULT_STABLE_CONNECTION_MS = 10_000;
/** Spreads the first redial, so every Mac does not dial in the same instant after a relay deploy. */
const FIRST_REDIAL_JITTER_MS = 250;

export interface ReconnectBackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  stableConnectionMs?: number;
}

export class ReconnectBackoff {
  private attempt = 0;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly stableConnectionMs: number;

  constructor(options: ReconnectBackoffOptions = {}) {
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    this.stableConnectionMs =
      options.stableConnectionMs ?? DEFAULT_STABLE_CONNECTION_MS;
  }

  reset(): void {
    this.attempt = 0;
  }

  nextDelayAfterClose(stableMs: number): number {
    if (stableMs > this.stableConnectionMs) {
      // A connection that worked just dropped: most drops are a blip, so dial again at once. The next tries wait 1, 2, 4... times the base.
      this.attempt = -1;
      return Math.floor(
        Math.random() * Math.min(FIRST_REDIAL_JITTER_MS, this.baseDelayMs),
      );
    }
    this.attempt += 1;
    return Math.min(this.baseDelayMs * 2 ** this.attempt, this.maxDelayMs);
  }
}
