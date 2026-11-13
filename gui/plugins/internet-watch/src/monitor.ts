import os from "node:os";

/**
 * How long the Mac's internet has stayed up, from three signals:
 *
 * 1. Real traffic: a turn that died on a network error resets it to "down".
 * 2. The OS: the Mac's network addresses changing (Wi-Fi drops or joins)
 *    triggers a check at once.
 * 3. A real request: HTTPS to the agents' own API hosts. Any HTTP answer, even
 *    a 404, proves DNS, TCP and TLS all work.
 *
 * "Wi-Fi connected" is not "internet works", and a flapping hotspot is not
 * either, so the answer is a duration of unbroken good checks, not a boolean.
 * Checks run only while a held thread keeps asking (`watch`).
 */

const PROBE_URLS = ["https://api.anthropic.com/", "https://chatgpt.com/"];
const PROBE_TIMEOUT_MS = 5_000;
const TICK_MS = 1_000;
export const CHECK_EVERY_MS = 5_000;
/** Checks stop this long after the last held thread asked for them. */
export const WATCH_MS = 2 * 60 * 1_000;
/** A check this recent counts as fresh evidence. */
const FRESH_MS = 60_000;
/**
 * How long the internet must stay up before each retry: the first retry needs
 * 5 s, then 30 s, 2 min and 5 min, so a flapping network cannot burn every
 * retry in a few minutes.
 */
export const STABLE_STEPS_MS = [5_000, 30_000, 120_000, 300_000];

export async function probeInternet(): Promise<boolean> {
  const answers = await Promise.allSettled(
    PROBE_URLS.map((url) =>
      fetch(url, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      }),
    ),
  );
  return answers.some((answer) => answer.status === "fulfilled");
}

/** Every external address the Mac has, as one comparable string. */
export function networkAddresses(): string {
  return Object.values(os.networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => !address.internal)
    .map((address) => address.address)
    .sort()
    .join(",");
}

export interface InternetMonitorOptions {
  /** Called when the internet has stayed up past one of `STABLE_STEPS_MS`. */
  onStable: () => void;
  probe?: () => Promise<boolean>;
  addresses?: () => string;
  now?: () => number;
}

export interface InternetMonitor {
  /** How long checks have found the internet up without a break; 0 if not. */
  stableForMs(): number;
  /** Whether a check finished within the last minute. */
  checkedRecently(): boolean;
  watching(): boolean;
  /** Keep checking for the next `WATCH_MS`. */
  watch(): void;
  /** A turn just died on the network: the internet is down now. */
  reportNetworkFailure(): void;
  stop(): void;
}

export function createInternetMonitor(
  options: InternetMonitorOptions,
): InternetMonitor {
  const probe = options.probe ?? probeInternet;
  const addresses = options.addresses ?? networkAddresses;
  const now = options.now ?? Date.now;
  let upSince: number | null = null;
  let lastStable = 0;
  let lastCheckAt: number | null = null;
  let watchUntil = 0;
  let nextCheckAt = 0;
  let lastAddresses = "";
  let checking = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stableForMs = () => (upSince === null ? 0 : now() - upSince);

  function resetStreak(): void {
    upSince = null;
    lastStable = 0;
  }

  function stopTimer(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
    resetStreak();
  }

  async function check(): Promise<void> {
    checking = true;
    let ok = false;
    try {
      ok = await probe();
    } catch {
      ok = false;
    } finally {
      checking = false;
    }
    if (stopped || timer === null) return;
    const at = now();
    lastCheckAt = at;
    nextCheckAt = at + CHECK_EVERY_MS;
    if (!ok) {
      resetStreak();
      return;
    }
    upSince ??= at;
    const stable = at - upSince;
    const crossed = STABLE_STEPS_MS.some(
      (step) => lastStable < step && stable >= step,
    );
    lastStable = stable;
    if (crossed) options.onStable();
  }

  function tick(): void {
    if (now() > watchUntil) {
      stopTimer();
      return;
    }
    if (checking) return;
    const current = addresses();
    if (current !== lastAddresses) {
      lastAddresses = current;
      nextCheckAt = 0;
    }
    if (now() >= nextCheckAt) void check();
  }

  function watch(): void {
    if (stopped) return;
    watchUntil = now() + WATCH_MS;
    if (timer !== null) return;
    // Nothing was checked while idle, so the streak starts over.
    resetStreak();
    nextCheckAt = 0;
    lastAddresses = addresses();
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
  }

  return {
    stableForMs,
    checkedRecently: () =>
      lastCheckAt !== null && now() - lastCheckAt <= FRESH_MS,
    watching: () => timer !== null,
    watch,
    reportNetworkFailure() {
      resetStreak();
      nextCheckAt = 0;
      watch();
    },
    stop() {
      stopped = true;
      stopTimer();
    },
  };
}
