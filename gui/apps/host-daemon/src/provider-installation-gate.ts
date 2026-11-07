import { bridgeLaunchProcessKey } from "@cloudroom/agent-runtime";
import type { HostDaemonBridgeLaunch } from "@cloudroom/host-daemon-contract";
import type {
  ProviderInstallationRequirement,
  ProviderInstallationStatus,
} from "@cloudroom/provider-bridge-protocol";

export const PROVIDER_INSTALLATION_GATE_TTL_MS = 5 * 60_000;

export interface ProviderInstallationGateKeyArgs {
  providerId: string;
  bridgeLaunch: HostDaemonBridgeLaunch;
  requirement?: ProviderInstallationRequirement;
}

export interface ProviderInstallationGate {
  /** The shell env changed. Saved answers stay for the fallback. */
  clear(): void;
  /** An install or update changed the CLI: clear() and forget saved answers,
   *  keeping a status the update already verified. */
  reset(verified?: { key: string; status: ProviderInstallationStatus }): void;
  /** Stops waiting when `signal` aborts. A probe that fails or runs out of
   *  time falls back to the newest answer this key got, and reports it
   *  through `onFallback`. */
  run(
    key: string,
    probe: () => Promise<ProviderInstallationStatus>,
    signal?: AbortSignal,
    onFallback?: (error: unknown) => void,
  ): Promise<ProviderInstallationStatus>;
}

interface CreateProviderInstallationGateOptions {
  ttlMs: number;
  now?: () => number;
  retryDelayMs?: number;
}

interface SettledEntry {
  expiresAt: number;
  status: ProviderInstallationStatus;
}

/** One check per key. Keeps its identity across re-runs, so a caller that
 *  gives up releases the probe that is actually running. */
interface ProbeOperation {
  promise: Promise<ProviderInstallationStatus>;
  waiting: number;
}

export function providerInstallationGateKey(
  args: ProviderInstallationGateKeyArgs,
): string {
  return `${args.providerId}#bridge:${bridgeLaunchProcessKey(args.bridgeLaunch)}#${args.requirement ?? "thread_start"}`;
}

export function createProviderInstallationGate({
  ttlMs,
  now = Date.now,
  retryDelayMs = 1_000,
}: CreateProviderInstallationGateOptions): ProviderInstallationGate {
  const settledByKey = new Map<string, SettledEntry>();
  // The newest answer per key survives clear(). A check that fails or runs
  // out of time falls back to it (#1048): a CLI that passed still starts, and
  // one reported unsupported stays blocked.
  const answeredByKey = new Map<
    string,
    { attempt: number; status: ProviderInstallationStatus }
  >();
  const pendingByKey = new Map<string, ProbeOperation>();
  let generation = 0;
  let attempts = 0;
  // Probes started before reset() answer for the old CLI.
  let resetAfterAttempt = 0;

  function pruneExpired(currentTime: number): void {
    for (const [key, entry] of settledByKey) {
      if (entry.expiresAt <= currentTime) {
        settledByKey.delete(key);
      }
    }
  }

  /** Saves an answer unless a newer one exists, and returns the newest. */
  function record(
    key: string,
    attempt: number,
    status: ProviderInstallationStatus,
    interrupted: boolean,
  ): ProviderInstallationStatus {
    const newest = answeredByKey.get(key);
    if (
      attempt <= resetAfterAttempt ||
      (newest !== undefined && attempt < newest.attempt)
    ) {
      return newest?.status ?? status;
    }
    answeredByKey.set(key, { attempt, status });
    const passed =
      (status.installed || status.minimumSupportedVersion === null) &&
      !status.versionUnsupported;
    if (!passed) {
      settledByKey.delete(key);
    } else if (!interrupted) {
      const settledAt = now();
      pruneExpired(settledAt);
      settledByKey.set(key, { status, expiresAt: settledAt + ttlMs });
    }
    return status;
  }

  function share(
    key: string,
    probe: () => Promise<ProviderInstallationStatus>,
  ): ProbeOperation {
    const settled = settledByKey.get(key);
    if (settled !== undefined) {
      if (settled.expiresAt > now()) {
        return { promise: Promise.resolve(settled.status), waiting: 0 };
      }
      settledByKey.delete(key);
    }
    const pending = pendingByKey.get(key);
    if (pending !== undefined) {
      return pending;
    }
    const operation = { waiting: 0 } as ProbeOperation;
    // A probe interrupted by clear() runs again, after a pause, while anyone
    // still waits. Each caller's deadline bounds that.
    const attempt = async (): Promise<ProviderInstallationStatus> => {
      const startedGeneration = generation;
      const attemptNumber = ++attempts;
      try {
        const status = await probe();
        const interrupted = startedGeneration !== generation;
        const newest = record(key, attemptNumber, status, interrupted);
        if (!interrupted || operation.waiting === 0) {
          return newest;
        }
      } catch (error) {
        if (startedGeneration === generation || operation.waiting === 0) {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      return attempt();
    };
    operation.promise = attempt().finally(() => {
      if (pendingByKey.get(key) === operation) {
        pendingByKey.delete(key);
      }
    });
    pendingByKey.set(key, operation);
    return operation;
  }

  function clear(): void {
    generation += 1;
    settledByKey.clear();
  }

  return {
    // A running check stays shared: it notices the change and runs again.
    clear,
    reset(verified) {
      clear();
      answeredByKey.clear();
      resetAfterAttempt = attempts;
      if (verified !== undefined) {
        answeredByKey.set(verified.key, {
          attempt: ++attempts,
          status: verified.status,
        });
      }
    },
    async run(key, probe, signal, onFallback) {
      const operation = share(key, probe);
      operation.waiting += 1;
      try {
        return await untilAborted(operation.promise, signal);
      } catch (error) {
        // Release a probe this caller gave up on, so the next start probes
        // again instead of joining a stalled one.
        if (signal?.aborted === true && pendingByKey.get(key) === operation) {
          pendingByKey.delete(key);
        }
        const answered = answeredByKey.get(key);
        if (answered !== undefined) {
          onFallback?.(error);
          return answered.status;
        }
        throw error;
      } finally {
        operation.waiting -= 1;
      }
    },
  };
}

export function untilAborted<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) {
      abort();
    }
  });
}
